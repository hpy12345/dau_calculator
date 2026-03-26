# -*- coding: utf-8 -*-
"""
Flask 路由分发模块 (routes.py)
==============================
包含页面渲染路由和 API 接口路由。

页面路由：
  GET  /                        -- 首页（项目管理）
  GET  /workspace/<project_id>  -- 工作区页面

API 路由：
  POST /api/project/create      -- 创建新项目
  POST /api/project/save        -- 保存项目数据
  GET  /api/project/<id>        -- 获取项目数据
  DELETE /api/project/<id>      -- 删除项目
  POST /api/calculate/dau       -- 计算 DAU
  POST /api/calculate/total     -- 计算全局汇总
"""

from flask import Blueprint, render_template, request, jsonify, redirect, url_for
from app.core import storage, calculator

# 创建蓝图，便于模块化管理路由
main_bp = Blueprint('main', __name__)


# ==================== 页面渲染路由 ====================

@main_bp.route('/')
def index():
    """
    首页：展示项目列表，提供新建项目入口
    后端读取 JSON 存储目录，将已有项目列表传递给 Jinja2 模板渲染
    """
    projects = storage.list_projects()
    return render_template('index.html', projects=projects)


@main_bp.route('/workspace/<project_id>')
def workspace(project_id):
    """
    工作区页面：数据输入与图表展示
    携带 project_id 加载项目数据，通过 Jinja2 服务端直出
    """
    project = storage.load_project(project_id)
    if project is None:
        return redirect(url_for('main.index'))
    return render_template('workspace.html', project=project)


# ==================== API 接口路由 ====================

@main_bp.route('/api/project/create', methods=['POST'])
def api_create_project():
    """
    创建新项目 API
    接收 JSON: {"project_name": "项目名称"}
    返回新项目数据（含 project_id），前端据此跳转到工作区
    """
    data = request.get_json(silent=True) or {}
    project_name = data.get('project_name', '').strip()

    if not project_name:
        return jsonify({'success': False, 'message': '项目名称不能为空'}), 400

    project = storage.create_project(project_name)
    return jsonify({
        'success': True,
        'project_id': project['project_id'],
        'message': '项目创建成功'
    })


@main_bp.route('/api/project/<project_id>', methods=['GET'])
def api_get_project(project_id):
    """
    获取项目完整数据 API
    前端切换标签页或刷新时可调用此接口获取最新数据
    """
    project = storage.load_project(project_id)
    if project is None:
        return jsonify({'success': False, 'message': '项目不存在'}), 404

    return jsonify({'success': True, 'data': project})


@main_bp.route('/api/project/save', methods=['POST'])
def api_save_project():
    """
    保存项目数据 API
    
    接收完整的项目数据 JSON，包含所有标签页的 DNU、留存率和计算结果。
    前端通过 fetch 异步提交，避免页面刷新。
    
    期望的 JSON Payload 结构：
    {
        "project_id": "xxxx",
        "project_name": "项目名",
        "tabs": [
            {
                "tab_name": "北美",
                "dnu_data": [{"day": 1, "value": 1500}, ...],
                "retention_data": [{"day": 1, "value": 0.45}, ...],
                "dau_result": [{"day": 1, "value": ...}, ...]
            }
        ]
    }
    """
    data = request.get_json(silent=True) or {}

    if not data.get('project_id'):
        return jsonify({'success': False, 'message': '缺少 project_id'}), 400

    try:
        storage.save_project(data)
        return jsonify({'success': True, 'message': '项目保存成功'})
    except Exception as e:
        return jsonify({'success': False, 'message': '保存失败: {}'.format(str(e))}), 500


@main_bp.route('/api/project/<project_id>', methods=['DELETE'])
def api_delete_project(project_id):
    """删除项目 API"""
    success = storage.delete_project(project_id)
    if success:
        return jsonify({'success': True, 'message': '项目已删除'})
    return jsonify({'success': False, 'message': '项目不存在'}), 404


@main_bp.route('/api/calculate/dau', methods=['POST'])
def api_calculate_dau():
    """
    计算单个标签页的 DAU API
    
    接收前端按 "天数-数据" 对应格式传来的 DNU 和留存率数据，
    通过 NumPy/Pandas 格式化后执行卷积运算，返回 DAU 结果数组。
    
    期望的 JSON Payload：
    {
        "tab_name": "北美",
        "dnu_data": [{"day": 1, "value": 1500}, {"day": 2, "value": 1800}],
        "retention_data": [{"day": 1, "value": 0.45}, {"day": 2, "value": 0.30}]
    }
    
    返回：
    {
        "success": true,
        "tab_name": "北美",
        "dau_result": [{"day": 1, "value": 1500.0}, {"day": 2, "value": 2475.0}]
    }
    """
    data = request.get_json(silent=True) or {}

    dnu_data = data.get('dnu_data', [])
    retention_data = data.get('retention_data', [])
    tab_name = data.get('tab_name', '')

    if not dnu_data:
        return jsonify({'success': False, 'message': 'DNU 数据不能为空'}), 400

    try:
        dau_result = calculator.calculate_dau(dnu_data, retention_data)
        return jsonify({
            'success': True,
            'tab_name': tab_name,
            'dau_result': dau_result
        })
    except Exception as e:
        return jsonify({'success': False, 'message': '计算失败: {}'.format(str(e))}), 500


@main_bp.route('/api/calculate/total', methods=['POST'])
def api_calculate_total():
    """
    计算全局汇总 DAU API
    
    接收所有标签页的数据，累加计算总 DNU 和总 DAU。
    
    期望的 JSON Payload：
    {
        "tabs": [
            {
                "tab_name": "北美",
                "dnu_data": [...],
                "dau_result": [...]
            },
            ...
        ]
    }
    """
    data = request.get_json(silent=True) or {}
    tabs = data.get('tabs', [])

    try:
        total = calculator.calculate_total_dau(tabs)
        return jsonify({
            'success': True,
            'total_dnu': total['total_dnu'],
            'total_dau': total['total_dau']
        })
    except Exception as e:
        return jsonify({'success': False, 'message': '汇总计算失败: {}'.format(str(e))}), 500
