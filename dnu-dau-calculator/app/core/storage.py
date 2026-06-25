# -*- coding: utf-8 -*-
"""
存储引擎模块 (storage.py)
========================
基于 JSON 文件系统存储项目数据，支持原子写入防止数据损坏。

存储目录结构：
  /data/projects/<project_id>.json   -- 项目配置与输入数据

设计要点：
  - DATA_DIR 可通过 init() 由应用工厂注入，便于测试与环境隔离
  - 写入采用「临时文件 + rename」原子操作，避免写入中途崩溃导致文件损坏
  - 目录存在性检查仅在首次调用时执行，后续直接复用
"""

import os
import json
import uuid
import tempfile
from datetime import datetime


# 数据存储根目录（默认值，可由 init() 覆盖）
DATA_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    'data', 'projects'
)

# 目录是否已确保存在的缓存标记
_dir_ensured = False


def init(data_dir):
    """
    初始化存储目录路径（由应用工厂 create_app 调用）。

    参数:
        data_dir (str): 数据存储目录的绝对路径
    """
    global DATA_DIR, _dir_ensured
    DATA_DIR = data_dir
    _dir_ensured = False
    _ensure_data_dir()


def _ensure_data_dir():
    """确保数据存储目录存在（仅首次调用时实际创建）。"""
    global _dir_ensured
    if _dir_ensured:
        return
    os.makedirs(DATA_DIR, exist_ok=True)
    _dir_ensured = True


def _project_json_path(project_id):
    """获取项目 JSON 文件的完整路径"""
    return os.path.join(DATA_DIR, '{}.json'.format(project_id))


def _atomic_write_json(filepath, data):
    """
    原子写入 JSON 文件：先写入临时文件，再通过 os.replace 重命名。

    os.replace 在同一文件系统上是原子的，可避免写入中途崩溃导致数据损坏。
    """
    _ensure_data_dir()
    dir_name = os.path.dirname(filepath)
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, filepath)
    except Exception:
        # 出错时清理临时文件
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise


# ==================== 项目 CRUD ====================

def create_project(project_name):
    """
    创建新项目

    参数:
        project_name (str): 项目名称

    返回:
        dict: 新创建的项目数据字典，包含 project_id

    说明:
        - 使用 uuid4 生成 12 位短 ID
        - 初始化默认标签页 "北美"
        - 通过原子写入持久化到 JSON 文件
    """
    _ensure_data_dir()

    project_id = uuid.uuid4().hex[:12]
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    project_data = {
        'project_id': project_id,
        'project_name': project_name,
        'created_at': now,
        'updated_at': now,
        'tabs': [
            {
                'tab_name': '北美',
                'dnu_data': [],
                'retention_data': [],
                'dau_result': []
            }
        ]
    }

    _atomic_write_json(_project_json_path(project_id), project_data)
    return project_data


def load_project(project_id):
    """
    加载指定项目的完整数据

    参数:
        project_id (str): 项目唯一标识

    返回:
        dict: 项目数据字典，若项目不存在则返回 None
    """
    json_path = _project_json_path(project_id)
    if not os.path.exists(json_path):
        return None

    with open(json_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_project(project_data):
    """
    保存/更新项目数据

    参数:
        project_data (dict): 完整的项目数据字典，必须包含 project_id

    说明:
        - 自动更新 updated_at 时间戳
        - 使用原子写入覆盖对应 JSON 文件
    """
    project_id = project_data.get('project_id')
    if not project_id:
        raise ValueError('项目数据缺少 project_id 字段')

    project_data['updated_at'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    _atomic_write_json(_project_json_path(project_id), project_data)


def list_projects():
    """
    列出所有已保存的项目摘要信息

    返回:
        list[dict]: 项目摘要列表，每项包含 project_id, project_name,
                    created_at, updated_at, tab_count，按更新时间倒序排列
    """
    _ensure_data_dir()

    projects = []
    for filename in os.listdir(DATA_DIR):
        if not filename.endswith('.json'):
            continue
        filepath = os.path.join(DATA_DIR, filename)
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
            projects.append({
                'project_id': data.get('project_id', ''),
                'project_name': data.get('project_name', '未命名项目'),
                'created_at': data.get('created_at', ''),
                'updated_at': data.get('updated_at', ''),
                'tab_count': len(data.get('tabs', []))
            })
        except (json.JSONDecodeError, IOError):
            # 跳过损坏的文件
            continue

    projects.sort(key=lambda x: x.get('updated_at', ''), reverse=True)
    return projects


def delete_project(project_id):
    """
    删除指定项目

    参数:
        project_id (str): 项目唯一标识

    返回:
        bool: 删除成功返回 True，项目不存在返回 False
    """
    json_path = _project_json_path(project_id)
    if not os.path.exists(json_path):
        return False
    os.remove(json_path)
    return True
