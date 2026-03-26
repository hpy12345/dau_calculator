# -*- coding: utf-8 -*-
"""
DAU 计算引擎模块 (calculator.py)
================================
基于 NumPy/Pandas 的 DAU（日活跃用户）核心计算逻辑。

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


def _parse_day_value_pairs(data_list):
    """
    将前端传来的 "天数-数据" 对象数组转换为 Pandas Series
    
    参数:
        data_list (list[dict]): 格式为 [{"day": 1, "value": 1500}, ...] 的对象数组
    
    返回:
        pd.Series: 以天数为索引、数值为值的 Series，按天数升序排列
    
    说明:
        前端统一使用 {"day": N, "value": V} 格式传递数据，
        后端在此处统一转换为 Pandas 数据结构以便后续向量化运算。
    """
    if not data_list:
        return pd.Series(dtype=float)

    df = pd.DataFrame(data_list)
    # 确保 day 列为整数，value 列为浮点数
    df['day'] = df['day'].astype(int)
    df['value'] = df['value'].astype(float)
    # 按天数排序，以天数为索引
    df = df.sort_values('day').set_index('day')
    return df['value']


def _series_to_day_value_pairs(series):
    """
    将 Pandas Series 转换回前端所需的 "天数-数据" 对象数组格式
    
    参数:
        series (pd.Series): 以天数为索引的 Series
    
    返回:
        list[dict]: 格式为 [{"day": 1, "value": 1500.0}, ...] 的对象数组
    """
    result = []
    for day, value in series.items():
        result.append({
            'day': int(day),
            'value': round(float(value), 2)
        })
    return result


def calculate_dau(dnu_data, retention_data):
    """
    核心 DAU 计算函数
    
    参数:
        dnu_data (list[dict]): DNU 数据，格式 [{"day": 1, "value": 1500}, ...]
        retention_data (list[dict]): 留存率数据，格式 [{"day": 1, "value": 0.45}, ...]
    
    返回:
        list[dict]: DAU 计算结果，格式 [{"day": 1, "value": ...}, ...]
    
    算法说明:
        使用 NumPy 的 np.convolve 实现 DNU 与留存率的离散卷积：
        
        1. 将 DNU 序列和留存率序列对齐为从第1天开始的连续数组
        2. 留存率序列需要在首位插入 1.0（第0天留存率=100%，即当天新增即为当天活跃）
        3. 执行卷积运算：DAU = convolve(DNU, Retention)
        4. 截取与 DNU 等长的有效部分作为结果
    """
    # 解析前端传来的天数-数据对
    dnu_series = _parse_day_value_pairs(dnu_data)
    ret_series = _parse_day_value_pairs(retention_data)

    if dnu_series.empty:
        return []

    # ========== 数据预处理 ==========
    # 获取 DNU 的天数范围
    max_day = int(dnu_series.index.max())
    
    # 构建连续的 DNU 数组（缺失天数填充0）
    dnu_array = np.zeros(max_day, dtype=float)
    for day, value in dnu_series.items():
        idx = int(day) - 1  # 天数从1开始，数组索引从0开始
        if 0 <= idx < max_day:
            dnu_array[idx] = value

    # 构建留存率数组
    # 第0天留存率为 1.0（当天新增用户当天即为活跃用户）
    # 后续天数按传入的留存率数据填充
    if ret_series.empty:
        # 若无留存率数据，默认只有当天活跃
        retention_array = np.array([1.0])
    else:
        max_ret_day = int(ret_series.index.max())
        retention_array = np.zeros(max_ret_day + 1, dtype=float)
        retention_array[0] = 1.0  # 第0天（当天）留存率 = 100%
        for day, value in ret_series.items():
            idx = int(day)
            if 0 < idx <= max_ret_day:
                retention_array[idx] = value

    # ========== 核心卷积运算 ==========
    # np.convolve 计算两个序列的离散卷积
    # mode='full' 返回完整卷积结果，长度为 len(dnu) + len(ret) - 1
    dau_full = np.convolve(dnu_array, retention_array, mode='full')

    # 只取前 max_day 天的结果（与 DNU 天数对齐）
    dau_array = dau_full[:max_day]

    # ========== 结果格式化 ==========
    # 转换为 Pandas Series 再输出为天数-数据对格式
    dau_series = pd.Series(dau_array, index=range(1, max_day + 1))
    dau_series.index.name = 'day'

    return _series_to_day_value_pairs(dau_series)


def calculate_total_dau(all_tabs_data):
    """
    汇总所有标签页的 DNU 和 DAU 数据，用于全局汇总分析图表
    
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
    
    说明:
        将所有标签页的 DNU 和 DAU 按天数对齐后逐天累加，
        利用 Pandas 的 DataFrame 自动对齐索引特性简化累加逻辑。
    """
    if not all_tabs_data:
        return {'total_dnu': [], 'total_dau': []}

    # 收集所有标签页的 DNU Series
    dnu_frames = []
    dau_frames = []

    for tab in all_tabs_data:
        tab_name = tab.get('tab_name', '')

        # 解析 DNU
        dnu_s = _parse_day_value_pairs(tab.get('dnu_data', []))
        if not dnu_s.empty:
            dnu_frames.append(dnu_s.rename(tab_name))

        # 解析 DAU 结果
        dau_s = _parse_day_value_pairs(tab.get('dau_result', []))
        if not dau_s.empty:
            dau_frames.append(dau_s.rename(tab_name))

    # 使用 Pandas concat + sum 实现按天数自动对齐累加
    total_dnu = pd.Series(dtype=float)
    total_dau = pd.Series(dtype=float)

    if dnu_frames:
        dnu_df = pd.concat(dnu_frames, axis=1).fillna(0)
        total_dnu = dnu_df.sum(axis=1)

    if dau_frames:
        dau_df = pd.concat(dau_frames, axis=1).fillna(0)
        total_dau = dau_df.sum(axis=1)

    return {
        'total_dnu': _series_to_day_value_pairs(total_dnu),
        'total_dau': _series_to_day_value_pairs(total_dau)
    }


def fit_retention_curve(retention_data):
    """
    预留接口：基于离散留存率数据点进行曲线拟合
    
    参数:
        retention_data (list[dict]): 留存率数据点
    
    返回:
        dict: 拟合结果（当前返回 Mock 数据，后续接入 SciPy curve_fit）
    
    说明:
        后续可使用 scipy.optimize.curve_fit 拟合幂律衰减模型：
        Retention(t) = a * t^(-b) + c
        目前仅预留接口，返回原始数据。
    """
    # TODO: 接入 SciPy 曲线拟合
    # from scipy.optimize import curve_fit
    # def power_law(t, a, b, c):
    #     return a * np.power(t, -b) + c
    # popt, pcov = curve_fit(power_law, days, values)

    return {
        'fitted': False,
        'message': '曲线拟合接口预留，尚未实现',
        'original_data': retention_data
    }
