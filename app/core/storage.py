# -*- coding: utf-8 -*-
"""
存储引擎模块 (storage.py)
========================
基于 JSON 文件系统存储业务配置与项目数据，
大型 DataFrame 数据缓存使用 Pickle。

存储目录结构：
  /data
    /projects
      <project_id>.json      -- 项目配置与输入数据
      <project_id>_cache.pkl  -- 计算结果缓存 (Pickle)
"""

import os
import json
import uuid
import pickle
from datetime import datetime


# 时间格式常量，统一全模块的时间序列化格式
_DATETIME_FMT = '%Y-%m-%d %H:%M:%S'

# 数据存储根目录（相对于项目根目录）
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'data', 'projects')


def _now_str():
    """获取当前时间的格式化字符串"""
    return datetime.now().strftime(_DATETIME_FMT)


def _ensure_data_dir():
    """确保数据存储目录存在，不存在则自动创建"""
    os.makedirs(DATA_DIR, exist_ok=True)


def _project_json_path(project_id):
    """获取项目 JSON 文件的完整路径"""
    return os.path.join(DATA_DIR, f'{project_id}.json')


def _project_pickle_path(project_id):
    """获取项目 Pickle 缓存文件的完整路径"""
    return os.path.join(DATA_DIR, f'{project_id}_cache.pkl')


def create_project(project_name):
    """
    创建新项目
    
    参数:
        project_name (str): 项目名称
    
    返回:
        dict: 新创建的项目数据字典，包含 project_id
    
    说明:
        - 使用 uuid4 生成唯一项目ID
        - 初始化默认标签页 "北美"
        - 将项目数据序列化为 JSON 写入文件系统
    """
    _ensure_data_dir()

    project_id = uuid.uuid4().hex[:12]  # 取前12位作为短ID
    now = _now_str()

    # 项目数据结构定义
    project_data = {
        'project_id': project_id,
        'project_name': project_name,
        'created_at': now,
        'updated_at': now,
        # tabs 数组：每个标签页代表一个地区/渠道
        'tabs': [
            {
                'tab_name': '北美',
                # DNU数据：天数-数值 对应的对象数组
                'dnu_data': [],
                # 留存率数据：天数-数值 对应的对象数组
                'retention_data': [],
                # 计算结果缓存（轻量级结果直接存JSON）
                'dau_result': []
            }
        ]
    }

    # 写入 JSON 文件
    json_path = _project_json_path(project_id)
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(project_data, f, ensure_ascii=False, indent=2)

    return project_data


def load_project(project_id):
    """
    加载指定项目的完整数据
    
    参数:
        project_id (str): 项目唯一标识
    
    返回:
        dict: 项目数据字典，若项目不存在或数据损坏则返回 None
    """
    json_path = _project_json_path(project_id)
    if not os.path.exists(json_path):
        return None

    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return None


def save_project(project_data):
    """
    保存/更新项目数据
    
    参数:
        project_data (dict): 完整的项目数据字典，必须包含 project_id
    
    说明:
        - 自动更新 updated_at 时间戳
        - 保留原有的 created_at 字段，防止前端未传递时丢失
        - 将整个项目数据覆盖写入对应的 JSON 文件
    """
    _ensure_data_dir()

    project_id = project_data.get('project_id')
    if not project_id:
        raise ValueError('项目数据缺少 project_id 字段')

    # 若前端未传递 created_at，尝试从已有文件中恢复
    if 'created_at' not in project_data:
        existing_data = load_project(project_id)
        if existing_data and 'created_at' in existing_data:
            project_data['created_at'] = existing_data['created_at']
        else:
            # 新项目或数据损坏，使用当前时间
            project_data['created_at'] = _now_str()

    project_data['updated_at'] = _now_str()

    json_path = _project_json_path(project_id)
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(project_data, f, ensure_ascii=False, indent=2)


def list_projects():
    """
    列出所有已保存的项目摘要信息
    
    返回:
        list[dict]: 项目摘要列表，每项包含 project_id, project_name, created_at, updated_at
    
    说明:
        - 扫描数据目录下所有 .json 文件（排除 _cache.pkl）
        - 按更新时间倒序排列
    """
    _ensure_data_dir()

    projects = []
    for filename in os.listdir(DATA_DIR):
        if not filename.endswith('.json'):
            continue
        # 从文件名提取 project_id，复用 load_project 避免重复的文件读取逻辑
        project_id = filename[:-5]  # 去掉 '.json' 后缀
        data = load_project(project_id)
        if data is None:
            continue
        tabs = data.get('tabs', [])
        projects.append({
            'project_id': data.get('project_id', ''),
            'project_name': data.get('project_name', '未命名项目'),
            'created_at': data.get('created_at', ''),
            'updated_at': data.get('updated_at', ''),
            'tab_count': len(tabs),
            'tab_names': [t.get('tab_name', '') for t in tabs if t.get('tab_name')]
        })

    # 按更新时间倒序排列
    projects.sort(key=lambda x: x.get('updated_at', ''), reverse=True)
    return projects


def delete_project(project_id):
    """
    删除指定项目及其缓存文件
    
    参数:
        project_id (str): 项目唯一标识
    
    返回:
        bool: 删除成功返回 True，项目不存在返回 False
    """
    json_path = _project_json_path(project_id)
    pkl_path = _project_pickle_path(project_id)

    if not os.path.exists(json_path):
        return False

    os.remove(json_path)
    if os.path.exists(pkl_path):
        os.remove(pkl_path)

    return True


def save_dataframe_cache(project_id, dataframe):
    """
    使用 Pickle 缓存大型 DataFrame 计算结果
    
    参数:
        project_id (str): 项目唯一标识
        dataframe: 需要缓存的 Pandas DataFrame 对象
    
    说明:
        当计算结果数据量较大时，使用 Pickle 序列化存储
        比 JSON 更高效，且能完整保留 DataFrame 的数据类型
    """
    _ensure_data_dir()
    pkl_path = _project_pickle_path(project_id)
    with open(pkl_path, 'wb') as f:
        pickle.dump(dataframe, f, protocol=pickle.HIGHEST_PROTOCOL)


def load_dataframe_cache(project_id):
    """
    加载 Pickle 缓存的 DataFrame
    
    参数:
        project_id (str): 项目唯一标识
    
    返回:
        DataFrame 或 None: 缓存的 DataFrame，不存在或数据损坏则返回 None
    """
    pkl_path = _project_pickle_path(project_id)
    if not os.path.exists(pkl_path):
        return None

    try:
        with open(pkl_path, 'rb') as f:
            return pickle.load(f)
    except (pickle.UnpicklingError, IOError, EOFError):
        return None
