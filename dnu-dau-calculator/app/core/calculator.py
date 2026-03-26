# -*- coding: utf-8 -*-
"""
DAU 计算引擎模块 (calculator.py)
================================
基于 NumPy/Pandas 的 DAU（日活跃用户）核心计算逻辑。

核心算法原理：
  DAU(t) = Σ DNU(d) × Retention(t - d)，其中 d 从第0天到第t天
  
  即：第 t 天的日活 = 历史每一天的新增用户数 × 对应天数后的留存率 之和。
  这本质上是 DNU 序列与留存率序列的离散卷积 (Convolution)。

  投资期内（period_days 天），每天按固定/指定的 DNU 值投放新用户；
  投资结束后 DNU 为 0，DAU 随留存率衰减而逐步下降。

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


def calculate_dau(dnu_data, retention_data, total_days=None):
    """
    核心 DAU 计算函数
    
    参数:
        dnu_data (list[dict]): DNU 数据，格式 [{"day": 1, "value": 1500}, ...]
            - day 表示投资期内的第几天（从1开始）
            - value 表示当天的新增用户数
        retention_data (list[dict]): 留存率数据，格式 [{"day": 1, "value": 0.45}, ...]
            - day=1 表示次日留存率，day=2 表示第2天留存率，以此类推
            - value 为小数形式（如 0.45 表示 45%）
        total_days (int|None): 总计算天数。
            - 若指定，则计算 total_days 天的 DAU（包含投资结束后的衰减期）
            - 若不指定，默认为 投资期天数 + 留存率天数（自动覆盖完整衰减周期）
    
    返回:
        list[dict]: DAU 计算结果，格式 [{"day": 1, "value": ...}, ...]
    
    算法说明:
        使用 NumPy 的 np.convolve 实现 DNU 与留存率的离散卷积：
        
        1. 构建长度为 total_days 的 DNU 数组：投资期内填入每天的 DNU 值，其余天为 0
        2. 构建留存率向量：ret_vec[0] = 1.0（当天新增即为当天活跃），
           ret_vec[i] = 第 i 天的留存率
        3. 执行卷积运算：DAU = convolve(DNU, Retention)
        4. 截取前 total_days 天的有效结果
        
    举例:
        假设投资 3 天，每天 DNU = 1000，留存率 = [1.0, 0.4, 0.3, 0.25, ...]：
        Day 0: 1000 × 1.0 = 1000
        Day 1: 1000 × 1.0 + 1000 × 0.4 = 1400
        Day 2: 1000 × 1.0 + 1000 × 0.4 + 1000 × 0.3 = 1700
        Day 3: 0 + 1000 × 0.4 + 1000 × 0.3 + 1000 × 0.25 = 950
        投资期内 DAU 逐天攀升，停止投放后 DAU 随留存衰减而下降。
    """
    # 解析前端传来的天数-数据对
    dnu_series = _parse_day_value_pairs(dnu_data)
    ret_series = _parse_day_value_pairs(retention_data)

    if dnu_series.empty:
        return []

    # ========== 数据预处理 ==========
    # 获取投资期天数（DNU 数据覆盖的最大天数）
    period_days = int(dnu_series.index.max())

    # 获取留存率数据覆盖的最大天数
    max_ret_day = int(ret_series.index.max()) if not ret_series.empty else 0

    # 确定总计算天数：投资期 + 留存衰减期
    if total_days is None:
        # 默认计算到留存率数据能覆盖的完整衰减周期
        total_days = period_days + max_ret_day
    total_days = max(total_days, period_days)  # 至少覆盖投资期

    # ========== 构建 DNU 数组 ==========
    # 长度为 total_days，投资期内填入 DNU 值，其余天为 0
    dnu_array = np.zeros(total_days, dtype=float)
    for day, value in dnu_series.items():
        idx = int(day) - 1  # 天数从1开始，数组索引从0开始
        if 0 <= idx < total_days:
            dnu_array[idx] = value

    # ========== 构建留存率向量 ==========
    # ret_vec[0] = 1.0（第0天留存率 = 100%，当天新增用户当天即为活跃用户）
    # ret_vec[i] = 第 i 天的留存率
    if ret_series.empty:
        # 若无留存率数据，默认只有当天活跃
        retention_array = np.array([1.0])
    else:
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

    # 只取前 total_days 天的结果
    dau_array = dau_full[:total_days]

    # ========== 结果格式化 ==========
    # 转换为 Pandas Series 再输出为天数-数据对格式
    dau_series = pd.Series(dau_array, index=range(1, total_days + 1))
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