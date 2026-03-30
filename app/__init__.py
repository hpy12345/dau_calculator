# -*- coding: utf-8 -*-
"""
Flask 应用工厂模块
负责创建和配置 Flask 应用实例
"""
import os
from flask import Flask


def create_app():
    """
    应用工厂函数
    创建并配置 Flask 应用实例，注册蓝图和路由
    """
    app = Flask(__name__)

    # 基础配置
    app.config['SECRET_KEY'] = 'dnu-dau-calculator-secret-key'

    # 数据存储目录（JSON/Pickle 文件存放位置）
    data_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data')
    app.config['DATA_DIR'] = os.path.abspath(data_dir)
    os.makedirs(app.config['DATA_DIR'], exist_ok=True)

    # 注册路由蓝图
    from app.routes import main_bp
    app.register_blueprint(main_bp)

    return app
