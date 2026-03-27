#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
开发环境启动入口
使用方式: python run.py
"""
from app import create_app

app = create_app()

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5001)
