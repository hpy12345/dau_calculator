# -*- coding: utf-8 -*-
"""
留存率曲线存储模块 (retention_curves.py)
========================================
管理用户保存的留存率曲线数据，支持增删查和名称唯一性校验。

存储方式：
  所有曲线保存在一个 JSON 文件中：/data/retention_curves.json
  结构：
  {
    "curves": [
      {
        "id": "abc123",
        "name": "北美SLG留存",
        "data": [{"day": 1, "value": 0.45}, ...],
        "created_at": "2026-03-27 16:00:00",
        "updated_at": "2026-03-27 16:00:00"
      }
    ]
  }
"""

import os
import json
import uuid
from datetime import datetime


# 留存率曲线数据文件路径
_CURVES_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    'data', 'retention_curves.json'
)


def _ensure_file():
    """确保数据文件及其目录存在"""
    dir_path = os.path.dirname(_CURVES_FILE)
    if not os.path.exists(dir_path):
        os.makedirs(dir_path, exist_ok=True)
    if not os.path.exists(_CURVES_FILE):
        with open(_CURVES_FILE, 'w', encoding='utf-8') as f:
            json.dump({'curves': []}, f, ensure_ascii=False, indent=2)


def _load_all():
    """加载所有曲线数据"""
    _ensure_file()
    try:
        with open(_CURVES_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data.get('curves', [])
    except (json.JSONDecodeError, IOError):
        return []


def _save_all(curves):
    """保存所有曲线数据"""
    _ensure_file()
    with open(_CURVES_FILE, 'w', encoding='utf-8') as f:
        json.dump({'curves': curves}, f, ensure_ascii=False, indent=2)


def list_curves():
    """
    列出所有已保存的留存率曲线（摘要信息）

    返回:
        list[dict]: 曲线摘要列表，每项包含 id, name, data_count, created_at, updated_at
    """
    curves = _load_all()
    result = []
    for c in curves:
        result.append({
            'id': c.get('id', ''),
            'name': c.get('name', ''),
            'data_count': len(c.get('data', [])),
            'created_at': c.get('created_at', ''),
            'updated_at': c.get('updated_at', '')
        })
    # 按更新时间倒序
    result.sort(key=lambda x: x.get('updated_at', ''), reverse=True)
    return result


def get_curve(curve_id):
    """
    获取指定曲线的完整数据

    参数:
        curve_id (str): 曲线唯一标识

    返回:
        dict 或 None: 曲线完整数据，不存在返回 None
    """
    curves = _load_all()
    for c in curves:
        if c.get('id') == curve_id:
            return c
    return None


def check_name_exists(name, exclude_id=None):
    """
    检查曲线名称是否已存在

    参数:
        name (str): 要检查的名称
        exclude_id (str|None): 排除的曲线ID（用于编辑时排除自身）

    返回:
        bool: 名称已存在返回 True
    """
    curves = _load_all()
    for c in curves:
        if c.get('name') == name and c.get('id') != exclude_id:
            return True
    return False


def save_curve(name, data, curve_id=None):
    """
    保存留存率曲线

    参数:
        name (str): 曲线名称
        data (list[dict]): 留存率数据 [{"day": 1, "value": 0.45}, ...]
        curve_id (str|None): 若指定则更新已有曲线，否则新建

    返回:
        dict: 保存后的曲线数据

    异常:
        ValueError: 名称为空或名称重复
    """
    name = name.strip()
    if not name:
        raise ValueError('曲线名称不能为空')

    if check_name_exists(name, exclude_id=curve_id):
        raise ValueError('曲线名称「{}」已存在，请使用其他名称'.format(name))

    curves = _load_all()
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    if curve_id:
        # 更新已有曲线
        for c in curves:
            if c.get('id') == curve_id:
                c['name'] = name
                c['data'] = data
                c['updated_at'] = now
                _save_all(curves)
                return c
        # 未找到则新建
        curve_id = None

    if not curve_id:
        # 新建曲线
        new_curve = {
            'id': uuid.uuid4().hex[:12],
            'name': name,
            'data': data,
            'created_at': now,
            'updated_at': now
        }
        curves.append(new_curve)
        _save_all(curves)
        return new_curve


def delete_curve(curve_id):
    """
    删除指定曲线

    参数:
        curve_id (str): 曲线唯一标识

    返回:
        bool: 删除成功返回 True，不存在返回 False
    """
    curves = _load_all()
    original_len = len(curves)
    curves = [c for c in curves if c.get('id') != curve_id]

    if len(curves) < original_len:
        _save_all(curves)
        return True
    return False
