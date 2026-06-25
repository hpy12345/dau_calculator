/**
 * chart_render.js - Chart.js 图表封装模块
 * ==========================================
 * 挂载在 window.IAA.chart 命名空间下。
 * 基于 Chart.js 4.x 封装折线图渲染逻辑，
 * 负责 DNU/DAU 对比曲线和全局汇总曲线的绑定与销毁。
 *
 * 设计说明：
 *   - 每个 Canvas 对应一个 Chart 实例，存储在内部 Map 中
 *   - 切换 Tab 或重新计算时，先销毁旧实例再创建新实例
 *   - 配色遵循蓝白主色调：DNU 用浅蓝，DAU 用深蓝
 */

;(function (global) {
    'use strict';

    var IAA = global.IAA;

    // 存储所有 Chart 实例，key 为 canvas ID
    var chartInstances = {};

    // ========== 配色常量（蓝白主色调） ==========
    var COLORS = {
        dnuLine: 'rgba(66, 133, 244, 0.8)',       // 浅蓝 - DNU 曲线
        dnuFill: 'rgba(66, 133, 244, 0.1)',        // DNU 填充区域
        dauLine: 'rgba(26, 115, 232, 1)',          // 深蓝 - DAU 曲线
        dauFill: 'rgba(26, 115, 232, 0.15)',       // DAU 填充区域
        totalDnuLine: 'rgba(100, 181, 246, 0.9)',  // 汇总 DNU
        totalDnuFill: 'rgba(100, 181, 246, 0.1)',
        totalDauLine: 'rgba(13, 71, 161, 1)',      // 汇总 DAU（更深蓝）
        totalDauFill: 'rgba(13, 71, 161, 0.15)',
        gridColor: 'rgba(0, 0, 0, 0.06)',
        textColor: '#5f6368'
    };

    /**
     * 销毁指定 Canvas 上的 Chart 实例
     * 切换 Tab 或重新计算前必须先销毁，否则 Chart.js 会报错
     *
     * @param {string} canvasId - Canvas 元素的 ID
     */
    function destroy(canvasId) {
        if (chartInstances[canvasId]) {
            chartInstances[canvasId].destroy();
            delete chartInstances[canvasId];
        }
    }

    /**
     * 从 "天数-数据" 对象数组中提取标签和数值
     * 将后端返回的 [{day:1, value:1500}, ...] 转换为 Chart.js 所需的 labels 和 data 数组
     *
     * @param {Array<Object>} dayValuePairs - [{day: 1, value: 1500}, ...]
     * @returns {Object} { labels: ['Day 1', ...], values: [1500, ...] }
     */
    function _extractChartData(dayValuePairs) {
        var labels = [];
        var values = [];

        if (!dayValuePairs || !dayValuePairs.length) {
            return { labels: labels, values: values };
        }

        // 按天数排序
        var sorted = dayValuePairs.slice().sort(function (a, b) {
            return a.day - b.day;
        });

        for (var i = 0; i < sorted.length; i++) {
            labels.push('Day ' + sorted[i].day);
            values.push(sorted[i].value);
        }

        return { labels: labels, values: values };
    }

    /**
     * 构建单个折线图数据集配置
     *
     * @param {string} label - 数据集名称
     * @param {Array<number>} data - 数据点数组
     * @param {string} lineColor - 线条颜色
     * @param {string} fillColor - 填充区域颜色
     * @param {number} borderWidth - 线宽
     * @returns {Object} Chart.js dataset 配置对象
     */
    function _buildDataset(label, data, lineColor, fillColor, borderWidth) {
        return {
            label: label,
            data: data,
            borderColor: lineColor,
            backgroundColor: fillColor,
            borderWidth: borderWidth,
            fill: true,
            tension: 0.3,
            pointRadius: 3,
            pointHoverRadius: 5
        };
    }

    /**
     * 获取通用的 Chart.js 配置选项
     * @returns {Object} Chart.js options 配置
     */
    function _getCommonOptions() {
        return {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: COLORS.textColor,
                        font: { size: 13, weight: '500' },
                        padding: 16,
                        usePointStyle: true,
                        pointStyleWidth: 12
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(32, 33, 36, 0.9)',
                    titleFont: { size: 13 },
                    bodyFont: { size: 12 },
                    padding: 10,
                    cornerRadius: 6,
                    callbacks: {
                        label: function (context) {
                            var label = context.dataset.label || '';
                            var value = context.parsed.y;
                            // 格式化数值：大于1的显示整数，小于1的显示小数
                            if (value < 1) {
                                return label + ': ' + (value * 100).toFixed(1) + '%';
                            }
                            return label + ': ' + value.toLocaleString();
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: COLORS.gridColor },
                    ticks: { color: COLORS.textColor, font: { size: 11 } }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: COLORS.gridColor },
                    ticks: {
                        color: COLORS.textColor,
                        font: { size: 11 },
                        callback: function (value) {
                            if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
                            if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
                            return value;
                        }
                    }
                }
            }
        };
    }

    /**
     * 通用折线图渲染核心函数
     * 统一处理实例销毁、Canvas 获取和 Chart 创建逻辑
     *
     * @param {string} canvasId - Canvas 元素 ID
     * @param {Array<Object>} datasets - Chart.js 数据集数组
     * @param {Array<string>} labels - X 轴标签数组
     */
    function _renderLineChart(canvasId, datasets, labels) {
        destroy(canvasId);

        var canvas = document.getElementById(canvasId);
        if (!canvas) return;

        var chart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { labels: labels, datasets: datasets },
            options: _getCommonOptions()
        });

        chartInstances[canvasId] = chart;
    }

    /**
     * 渲染单个标签页的 DNU + DAU 对比折线图
     *
     * @param {string} canvasId - Canvas 元素 ID
     * @param {Array<Object>} dnuData - DNU 数据 [{day:1, value:1500}, ...]
     * @param {Array<Object>} dauData - DAU 计算结果 [{day:1, value:...}, ...]
     * @param {string} [tabName] - 标签名称（预留参数，当前未使用）
     */
    function renderDauChart(canvasId, dnuData, dauData, tabName) {
        var dnuParsed = _extractChartData(dnuData);
        var dauParsed = _extractChartData(dauData);

        // 使用较长的标签数组作为 X 轴
        var labels = dnuParsed.labels.length >= dauParsed.labels.length
            ? dnuParsed.labels : dauParsed.labels;

        var datasets = [
            _buildDataset('DNU（日新增用户）', dnuParsed.values, COLORS.dnuLine, COLORS.dnuFill, 2),
            _buildDataset('DAU（日活跃用户）', dauParsed.values, COLORS.dauLine, COLORS.dauFill, 2.5)
        ];

        _renderLineChart(canvasId, datasets, labels);
    }

    /**
     * 渲染全局汇总图表
     * 展示所有标签页数据累加后的 DNU 总和曲线和 DAU 总和曲线
     *
     * @param {string} canvasId - Canvas 元素 ID
     * @param {Array<Object>} totalDnu - 累加 DNU [{day:1, value:...}, ...]
     * @param {Array<Object>} totalDau - 累加 DAU [{day:1, value:...}, ...]
     */
    function renderTotalChart(canvasId, totalDnu, totalDau) {
        var dnuParsed = _extractChartData(totalDnu);
        var dauParsed = _extractChartData(totalDau);

        var labels = dnuParsed.labels.length >= dauParsed.labels.length
            ? dnuParsed.labels : dauParsed.labels;

        var datasets = [
            _buildDataset('DNU 累加总和', dnuParsed.values, COLORS.totalDnuLine, COLORS.totalDnuFill, 2),
            _buildDataset('DAU 累加总和', dauParsed.values, COLORS.totalDauLine, COLORS.totalDauFill, 2.5)
        ];

        _renderLineChart(canvasId, datasets, labels);
    }

    // ========== 公开 API ==========
    IAA.chart = {
        renderDauChart: renderDauChart,
        renderTotalChart: renderTotalChart,
        destroy: destroy
    };

})(window);
