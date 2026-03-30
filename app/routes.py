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
  GET  /api/retention-curves     -- 获取已保存的留存率曲线列表
  POST /api/retention-curves     -- 保存留存率曲线
  GET  /api/retention-curves/<id> -- 获取单条留存率曲线
  DELETE /api/retention-curves/<id> -- 删除留存率曲线
  POST /api/retention-curves/check-name -- 校验曲线名称唯一性
"""

from flask import Blueprint, render_template, request, jsonify, redirect, url_for
from app.core import storage, calculator, retention_curves

# 创建蓝图，便于模块化管理路由
main_bp = Blueprint('main', __name__)


# ==================== 辅助函数 ====================

def _get_json_payload():
    """获取请求中的 JSON 数据，解析失败时返回空字典。"""
    return request.get_json(silent=True) or {}


def _success_response(message='操作成功', **kwargs):
    """构建统一的成功响应。"""
    return jsonify({'success': True, 'message': message, **kwargs})


def _error_response(message, status_code=400):
    """构建统一的错误响应。"""
    return jsonify({'success': False, 'message': message}), status_code


def _parse_positive_int(value):
    """
    将值解析为正整数，无效时返回 None。

    用于解析 total_days 等需要正整数的参数。
    """
    if value is None:
        return None
    try:
        result = int(value)
        return result if result > 0 else None
    except (ValueError, TypeError):
        return None


# ==================== 页面渲染路由 ====================

@main_bp.route('/')
def index():
    """首页：展示项目列表，提供新建项目入口。"""
    projects = storage.list_projects()
    return render_template('index.html', projects=projects)


@main_bp.route('/workspace/<project_id>')
def workspace(project_id):
    """工作区页面：携带 project_id 加载项目数据并渲染。"""
    project = storage.load_project(project_id)
    if project is None:
        return redirect(url_for('main.index'))
    return render_template('workspace.html', project=project)


# ==================== 项目管理 API ====================

@main_bp.route('/api/project/create', methods=['POST'])
def api_create_project():
    """
    创建新项目 API。

    接收 JSON: {"project_name": "项目名称"}
    返回新项目数据（含 project_id），前端据此跳转到工作区。
    """
    data = _get_json_payload()
    project_name = data.get('project_name', '').strip()

    if not project_name:
        return _error_response('项目名称不能为空')

    project = storage.create_project(project_name)
    return _success_response('项目创建成功', project_id=project['project_id'])


@main_bp.route('/api/project/<project_id>', methods=['GET'])
def api_get_project(project_id):
    """获取项目完整数据 API。"""
    project = storage.load_project(project_id)
    if project is None:
        return _error_response('项目不存在', 404)

    return jsonify({'success': True, 'data': project})


@main_bp.route('/api/project/save', methods=['POST'])
def api_save_project():
    """
    保存项目数据 API。

    接收完整的项目数据 JSON，包含所有标签页的 DNU、留存率和计算结果。

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
    data = _get_json_payload()

    if not data.get('project_id'):
        return _error_response('缺少 project_id')

    try:
        storage.save_project(data)
        return _success_response('项目保存成功')
    except Exception as e:
        return _error_response(f'保存失败: {e}', 500)


@main_bp.route('/api/project/<project_id>', methods=['DELETE'])
def api_delete_project(project_id):
    """删除项目 API。"""
    if storage.delete_project(project_id):
        return _success_response('项目已删除')
    return _error_response('项目不存在', 404)


# ==================== DAU 计算 API ====================

def _calculate_segmented(segments, default_retention, total_days):
    """
    分段留存率模式计算 DAU。

    对于没有指定专属留存率的时间段，使用标签页级别的默认留存率。
    """
    has_dnu = any(seg.get('dnu_data') for seg in segments)
    if not has_dnu:
        return None, 'DNU 数据不能为空'

    for seg in segments:
        if not seg.get('retention_data'):
            seg['retention_data'] = default_retention

    return calculator.calculate_dau_segmented(segments, total_days=total_days), None


def _calculate_unified(dnu_data, retention_data, total_days):
    """统一留存率模式计算 DAU。"""
    if not dnu_data:
        return None, 'DNU 数据不能为空'

    return calculator.calculate_dau(dnu_data, retention_data, total_days=total_days), None


@main_bp.route('/api/calculate/dau', methods=['POST'])
def api_calculate_dau():
    """
    计算单个标签页的 DAU API。

    支持两种模式：
      模式1 - 统一留存率（向后兼容）
      模式2 - 分段留存率（每个 DNU 时间段使用专属留存率曲线）
    """
    data = _get_json_payload()

    tab_name = data.get('tab_name', '')
    total_days = _parse_positive_int(data.get('total_days'))
    segments = data.get('segments')

    try:
        if segments and isinstance(segments, list) and len(segments) > 0:
            # 模式2：分段留存率计算
            default_retention = data.get('retention_data', [])
            dau_result, err = _calculate_segmented(segments, default_retention, total_days)
        else:
            # 模式1：统一留存率（向后兼容）
            dau_result, err = _calculate_unified(
                data.get('dnu_data', []),
                data.get('retention_data', []),
                total_days,
            )

        if err:
            return _error_response(err)

        return jsonify({
            'success': True,
            'tab_name': tab_name,
            'dau_result': dau_result,
        })
    except Exception as e:
        return _error_response(f'计算失败: {e}', 500)


@main_bp.route('/api/calculate/total', methods=['POST'])
def api_calculate_total():
    """
    计算全局汇总 DAU API。

    接收所有标签页的数据，累加计算总 DNU 和总 DAU。
    """
    data = _get_json_payload()
    tabs = data.get('tabs', [])

    try:
        total = calculator.calculate_total_dau(tabs)
        return jsonify({
            'success': True,
            'total_dnu': total['total_dnu'],
            'total_dau': total['total_dau'],
        })
    except Exception as e:
        return _error_response(f'汇总计算失败: {e}', 500)


# ==================== 留存率曲线管理 API ====================

@main_bp.route('/api/retention-curves', methods=['GET'])
def api_list_retention_curves():
    """获取所有已保存的留存率曲线列表（摘要信息）。"""
    curves = retention_curves.list_curves()
    return jsonify({'success': True, 'curves': curves})


@main_bp.route('/api/retention-curves', methods=['POST'])
def api_save_retention_curve():
    """
    保存留存率曲线 API。

    期望的 JSON Payload：
    {
        "name": "北美SLG留存",
        "data": [{"day": 1, "value": 0.45}, ...],
        "curve_id": "xxx"  // 可选，指定则更新已有曲线
    }
    """
    data = _get_json_payload()
    name = data.get('name', '').strip()
    curve_data = data.get('data', [])
    curve_id = data.get('curve_id')

    if not name:
        return _error_response('曲线名称不能为空')

    if not curve_data:
        return _error_response('留存率数据不能为空')

    try:
        curve = retention_curves.save_curve(name, curve_data, curve_id=curve_id)
        return jsonify({
            'success': True,
            'curve': curve,
            'message': f'曲线「{name}」保存成功',
        })
    except ValueError as e:
        return _error_response(str(e))
    except Exception as e:
        return _error_response(f'保存失败: {e}', 500)


@main_bp.route('/api/retention-curves/check-name', methods=['POST'])
def api_check_curve_name():
    """校验曲线名称唯一性。"""
    data = _get_json_payload()
    name = data.get('name', '').strip()
    exclude_id = data.get('exclude_id')

    if not name:
        return jsonify({'success': True, 'exists': False})

    exists = retention_curves.check_name_exists(name, exclude_id=exclude_id)
    return jsonify({'success': True, 'exists': exists})


@main_bp.route('/api/retention-curves/<curve_id>', methods=['GET'])
def api_get_retention_curve(curve_id):
    """获取单条留存率曲线的完整数据。"""
    curve = retention_curves.get_curve(curve_id)
    if curve is None:
        return _error_response('曲线不存在', 404)
    return jsonify({'success': True, 'curve': curve})


@main_bp.route('/api/retention-curves/<curve_id>', methods=['DELETE'])
def api_delete_retention_curve(curve_id):
    """删除留存率曲线。"""
    if retention_curves.delete_curve(curve_id):
        return _success_response('曲线已删除')
    return _error_response('曲线不存在', 404)