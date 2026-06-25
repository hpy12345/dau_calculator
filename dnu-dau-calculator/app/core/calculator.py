# -*- coding: utf-8 -*-
"""
DAU 计算引擎模块 (calculator.py)
================================
基于 NumPy 的 DAU（日活跃用户）核心计算逻辑。

核心算法原理：
  DAU(t) = Σ DNU(i) × Retention(t - i)，其中 i 从第1天到第t天

  即：第 t 天的日活 = 历史每一天的新增用户数 × 对应天数后的留存率 之和。
  这本质上是 DNU 序列与留存率序列的离散卷积 (Convolution)。

数据格式约定（天数-数据 对应）：
  DNU 数据:       [{"day": 1, "value": 1500}, {"day": 2, "value": 1800}, ...]
  留存率数据:     [{"day": 1, "value": 0.45}, {"day": 2, "value": 0.30}, ...]
  DAU 计算结果:   [{"day": 1, "value": 1500}, {"day": 2, "value": 2475}, ...]
"""

import numpy as np
import pandas as pd


# ==================== 数据格式转换工具 ====================

def _parse_day_value_pairs(data_list):
    """
    将前端传来的 "天数-数据" 对象数组转换为 Pandas Series。

    参数:
        data_list (list[dict]): 格式为 [{"day": 1, "value": 1500}, ...] 的对象数组

    返回:
        pd.Series: 以天数为索引、数值为值的 Series，按天数升序排列
    """
    if not data_list:
        return pd.Series(dtype=float)

    df = pd.DataFrame(data_list)
    df['day'] = df['day'].astype(int)
    df['value'] = df['value'].astype(float)
    df = df.sort_values('day').set_index('day')
    return df['value']


def _series_to_day_value_pairs(series):
    """
    将 Pandas Series 转换回前端所需的 "天数-数据" 对象数组格式。

    参数:
        series (pd.Series): 以天数为索引的 Series

    返回:
        list[dict]: 格式为 [{"day": 1, "value": 1500.0}, ...] 的对象数组
    """
    if series.empty:
        return []
    return [
        {'day': int(day), 'value': round(float(value), 2)}
        for day, value in series.items()
    ]


def _build_contiguous_array(pairs, start_offset):
    """
    将 "天数-数据" 对象数组构建为从 start_offset 天开始的连续 NumPy 数组。

    缺失天数填充 0，使用 NumPy 向量化索引赋值（无 Python 逐元素循环）。

    参数:
        pairs (list[dict]): [{"day": N, "value": V}, ...]
        start_offset (int): 天数起始偏移量
            - DNU 数据从第 1 天开始 → start_offset=1
            - 留存率数据从第 0 天开始 → start_offset=0

    返回:
        tuple[np.ndarray, int]: (连续数组, 最大天数)，空输入返回 (空数组, 0)
    """
    if not pairs:
        return np.array([]), 0

    days = np.fromiter((int(p['day']) for p in pairs), dtype=int)
    values = np.fromiter((float(p['value']) for p in pairs), dtype=float)

    max_day = int(days.max())
    length = max_day - start_offset + 1
    if length <= 0:
        return np.array([]), 0

    arr = np.zeros(length, dtype=float)
    indices = days - start_offset
    # 仅写入索引有效范围内的数据
    valid = (indices >= 0) & (indices < length)
    arr[indices[valid]] = values[valid]
    return arr, max_day


# ==================== 核心计算函数 ====================

def calculate_dau(dnu_data, retention_data):
    """
    核心 DAU 计算函数

    使用 NumPy 的 np.convolve 实现 DNU 与留存率的离散卷积：
      DAU = convolve(DNU, Retention)

    算法步骤：
      1. 将 DNU 序列构建为从第 1 天开始的连续数组（缺失天数填 0）
      2. 将留存率序列构建为从第 0 天开始的连续数组，第 0 天（当天）留存率 = 1.0
      3. 执行卷积运算并截取与 DNU 等长的有效部分

    参数:
        dnu_data (list[dict]): DNU 数据，格式 [{"day": 1, "value": 1500}, ...]
        retention_data (list[dict]): 留存率数据，格式 [{"day": 1, "value": 0.45}, ...]

    返回:
        list[dict]: DAU 计算结果，格式 [{"day": 1, "value": ...}, ...]

    示例:
        >>> calculate_dau(
        ...     [{"day": 1, "value": 1500}, {"day": 2, "value": 1800}],
        ...     [{"day": 1, "value": 0.45}]
        ... )
        [{'day': 1, 'value': 1500.0}, {'day': 2, 'value': 2475.0}]
    """
    # 构建 DNU 连续数组（从第 1 天开始）
    dnu_array, max_day = _build_contiguous_array(dnu_data, start_offset=1)
    if dnu_array.size == 0:
        return []

    # 构建留存率数组（从第 0 天开始，第 0 天 = 100%）
    if retention_data:
        ret_array, _ = _build_contiguous_array(retention_data, start_offset=0)
        ret_array[0] = 1.0  # 当天新增即当天活跃
    else:
        # 无留存率数据时，仅当天活跃
        ret_array = np.array([1.0])

    # 离散卷积：DAU(t) = Σ DNU(i) × Retention(t - i)
    dau_full = np.convolve(dnu_array, ret_array, mode='full')
    dau_array = dau_full[:max_day]

    # 格式化为天数-数据对输出
    return [
        {'day': day, 'value': round(float(value), 2)}
        for day, value in enumerate(dau_array, start=1)
    ]


def calculate_total_dau(all_tabs_data):
    """
    汇总所有标签页的 DNU 和 DAU 数据，用于全局汇总分析图表。

    将所有标签页的 DNU 和 DAU 按天数对齐后逐天累加，
    利用 Pandas 的 concat + 自动索引对齐特性简化多序列求和逻辑。

    参数:
        all_tabs_data (list[dict]): 所有标签页的数据列表，每项包含:
            - tab_name (str): 标签名称
            - dnu_data (list[dict]): DNU 数据
            - dau_result (list[dict]): 已计算的 DAU 结果

    返回:
        dict: {
            "total_dnu": [{"day": 1, "value": ...}, ...],
            "total_dau": [{"day": 1, "value": ...}, ...]
        }
    """
    if not all_tabs_data:
        return {'total_dnu': [], 'total_dau': []}

    dnu_frames = []
    dau_frames = []

    for tab in all_tabs_data:
        tab_name = tab.get('tab_name', '')

        dnu_s = _parse_day_value_pairs(tab.get('dnu_data', []))
        if not dnu_s.empty:
            dnu_frames.append(dnu_s.rename(tab_name))

        dau_s = _parse_day_value_pairs(tab.get('dau_result', []))
        if not dau_s.empty:
            dau_frames.append(dau_s.rename(tab_name))

    # concat 后按列求和，Pandas 自动对齐不同长度的索引
    total_dnu = (
        pd.concat(dnu_frames, axis=1).fillna(0).sum(axis=1)
        if dnu_frames else pd.Series(dtype=float)
    )
    total_dau = (
        pd.concat(dau_frames, axis=1).fillna(0).sum(axis=1)
        if dau_frames else pd.Series(dtype=float)
    )

    return {
        'total_dnu': _series_to_day_value_pairs(total_dnu),
        'total_dau': _series_to_day_value_pairs(total_dau)
    }
