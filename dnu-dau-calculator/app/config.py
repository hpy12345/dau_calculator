# -*- coding: utf-8 -*-
"""
应用配置模块 (config.py)
========================
基于环境变量的分层配置，支持开发与生产环境切换。

使用方式：
  export FLASK_ENV=production   # 或 development（默认）
"""

import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)


class Config:
    """基础配置（所有环境共享）"""

    # 密钥：优先从环境变量读取，开发环境提供默认值
    SECRET_KEY = os.environ.get('SECRET_KEY', 'dnu-dau-calculator-dev-secret')

    # 数据存储目录（JSON 项目文件存放位置）
    DATA_DIR = os.path.join(PROJECT_ROOT, 'data', 'projects')

    # JSON 响应允许中文直出
    JSON_AS_ASCII = False


class DevelopmentConfig(Config):
    """开发环境配置"""

    DEBUG = True


class ProductionConfig(Config):
    """生产环境配置"""

    DEBUG = False

    # 生产环境必须通过环境变量设置密钥
    SECRET_KEY = os.environ.get('SECRET_KEY', 'dnu-dau-calculator-change-me')


# 环境名 -> 配置类 映射表
config_map = {
    'development': DevelopmentConfig,
    'production': ProductionConfig,
}
