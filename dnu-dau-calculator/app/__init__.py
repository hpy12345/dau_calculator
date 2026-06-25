# -*- coding: utf-8 -*-
"""
Flask 应用工厂模块
负责创建和配置 Flask 应用实例
"""

import os
from flask import Flask

from app.config import config_map


def create_app(config_name=None):
    """
    应用工厂函数
    创建并配置 Flask 应用实例，注册蓝图和路由

    参数:
        config_name (str): 配置名称（'development' / 'production'），
                           默认从环境变量 FLASK_ENV 读取
    """
    if config_name is None:
        config_name = os.environ.get('FLASK_ENV', 'development')

    app = Flask(__name__)
    app.config.from_object(config_map.get(config_name, config_map['development']))

    # 确保数据存储目录存在
    os.makedirs(app.config['DATA_DIR'], exist_ok=True)

    # 初始化存储引擎的数据目录（注入应用配置中的路径）
    from app.core import storage
    storage.init(app.config['DATA_DIR'])

    # 注册路由蓝图
    from app.routes import main_bp
    app.register_blueprint(main_bp)

    return app
