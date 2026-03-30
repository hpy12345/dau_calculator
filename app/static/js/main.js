/**
 * main.js - 全局命名空间声明及基础工具函数
 * ============================================
 * 使用 ES5 IIFE 模块化模式，零现代框架依赖。
 * 所有业务模块挂载在 window.IAA 命名空间下，避免全局污染。
 *
 * 命名空间结构：
 *   window.IAA.utils    -- 通用工具函数（fetch封装、Toast提示等）
 *   window.IAA.workspace -- 工作区模块（由 workspace.js 注册）
 *   window.IAA.chart    -- 图表模块（由 chart_render.js 注册）
 *   window.IAA.excel    -- Excel解析模块（由 excel_parser.js 注册）
 */

;(function (global) {
    'use strict';

    // ========== 全局命名空间初始化 ==========
    var IAA = global.IAA || {};

    /**
     * 工具函数模块
     * 提供 fetch 封装、Toast 提示、DOM 辅助等基础能力
     */
    IAA.utils = (function () {

        /**
         * 封装 fetch 请求，统一处理 JSON 序列化和错误
         * 传统前后端交互中，不依赖 axios 等库，直接使用原生 fetch API
         *
         * @param {string} url - 请求地址
         * @param {Object} options - 请求配置
         * @param {string} options.method - HTTP 方法，默认 'GET'
         * @param {Object} options.body - 请求体（会自动 JSON.stringify）
         * @returns {Promise<Object>} 解析后的 JSON 响应
         */
        function request(url, options) {
            var opts = options || {};
            var method = opts.method || 'GET';
            var fetchConfig = {
                method: method,
                headers: {
                    'Content-Type': 'application/json'
                }
            };

            // GET 请求不携带 body
            if (method !== 'GET' && opts.body) {
                fetchConfig.body = JSON.stringify(opts.body);
            }

            return fetch(url, fetchConfig)
                .then(function (response) {
                    if (!response.ok) {
                        throw new Error('HTTP ' + response.status + ': ' + response.statusText);
                    }
                    return response.json();
                })
                .then(function (data) {
                    if (data.success === false) {
                        throw new Error(data.message || '请求失败');
                    }
                    return data;
                });
        }

        /**
         * 显示 Toast 提示消息
         * 不依赖任何 UI 框架，纯 DOM 操作实现
         *
         * @param {string} message - 提示文本
         * @param {string} type - 类型：'success' | 'error' | 'info'
         * @param {number} duration - 显示时长（毫秒），默认 3000
         */
        function showToast(message, type, duration) {
            var t = type || 'info';
            var d = duration || 3000;

            var toast = document.createElement('div');
            toast.className = 'toast toast--' + t;
            toast.textContent = message;
            document.body.appendChild(toast);

            // 使用 requestAnimationFrame 确保 DOM 渲染完成后再设置淡出定时器
            requestAnimationFrame(function () {
                setTimeout(function () {
                    toast.style.opacity = '0';
                    toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
                    toast.style.transform = 'translate(-50%, -50%) scale(0.9)';
                    setTimeout(function () {
                        if (toast.parentNode) {
                            toast.parentNode.removeChild(toast);
                        }
                    }, 300);
                }, d);
            });
        }

        /**
         * 简易 DOM 查询封装
         * @param {string} selector - CSS 选择器
         * @param {Element} context - 查询上下文，默认 document
         * @returns {Element|null}
         */
        function $(selector, context) {
            return (context || document).querySelector(selector);
        }

        /**
         * 查询所有匹配元素
         * @param {string} selector - CSS 选择器
         * @param {Element} context - 查询上下文
         * @returns {NodeList}
         */
        function $$(selector, context) {
            return (context || document).querySelectorAll(selector);
        }

        /**
         * 事件绑定封装
         * @param {Element} el - 目标元素
         * @param {string} event - 事件名
         * @param {Function} handler - 处理函数
         */
        function on(el, event, handler) {
            if (el && el.addEventListener) {
                el.addEventListener(event, handler, false);
            }
        }

        /**
         * 显示模态对话框
         * @param {string} overlaySelector - 遮罩层选择器
         */
        function showModal(overlaySelector) {
            var overlay = $(overlaySelector);
            if (overlay) {
                overlay.classList.add('active');
            }
        }

        /**
         * 隐藏模态对话框
         * @param {string} overlaySelector - 遮罩层选择器
         */
        function hideModal(overlaySelector) {
            var overlay = $(overlaySelector);
            if (overlay) {
                overlay.classList.remove('active');
            }
        }

        // 公开 API
        return {
            request: request,
            showToast: showToast,
            $: $,
            $$: $$,
            on: on,
            showModal: showModal,
            hideModal: hideModal
        };
    })();

    // 挂载到全局
    global.IAA = IAA;

})(window);
