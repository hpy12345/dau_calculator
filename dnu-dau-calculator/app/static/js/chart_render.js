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
 *   - 关键天数（1/7/30/60/90/180/365）使用红色高亮标注
 */

;(function (global) {
    'use strict';

    var IAA = global.IAA;

    // 存储所有 Chart 实例，key 为 canvas ID
    var chartInstances = {};

    // ========== 关键天数常量 ==========
    /** 关键天数列表，用于在图表上高亮标注 */
    var KEY_DAYS = [1, 7, 30, 60, 90, 180, 365];

    /** 关键天数的快速查找集合 */
    var KEY_DAY_SET = {};
    KEY_DAYS.forEach(function (kd) { KEY_DAY_SET[kd] = true; });

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

    /** 关键天数高亮点颜色 */
    var KEY_DAY_POINT_COLOR = '#e74c3c';

    /** 关键天数标签字体与颜色 */
    var KEY_DAY_LABEL_FONT = 'bold 11px sans-serif';
    var KEY_DAY_LABEL_COLOR = '#333';

    /** 标签偏移量（像素） */
    var LABEL_OFFSET_ABOVE = 12;
    var LABEL_OFFSET_BELOW = 18;
    var LABEL_MIN_Y = 16;

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
     * 销毁所有 Chart 实例
     */
    function destroyAllCharts() {
        Object.keys(chartInstances).forEach(function (key) {
            if (chartInstances[key]) {
                chartInstances[key].destroy();
                delete chartInstances[key];
            }
        });
    }

    /**
     * 从 "天数-数据" 对象数组中提取排序后的数据
     *
     * @param {Array<Object>} dayValuePairs - [{day: 1, value: 1500}, ...]
     * @returns {Array<Object>} 按天数排序后的数组
     */
    function _sortData(dayValuePairs) {
        if (!dayValuePairs || !dayValuePairs.length) {
            return [];
        }
        return dayValuePairs.slice().sort(function (a, b) {
            return a.day - b.day;
        });
    }

    /**
     * 构建关键天数标签插件
     * 在图表上直接显示关键天数的数值标签
     *
     * @param {Array<Object>} sorted - 排序后的数据点
     * @param {Function} formatFn - 数值格式化函数
     * @returns {Object} Chart.js 插件对象
     */
    function _buildKeyDayLabelsPlugin(sorted, formatFn) {
        return {
            id: 'keyDayLabels',
            afterDatasetsDraw: function (chart) {
                var ctx = chart.ctx;
                var dataset = chart.data.datasets[0];
                var meta = chart.getDatasetMeta(0);

                ctx.save();
                ctx.font = KEY_DAY_LABEL_FONT;
                ctx.textAlign = 'center';
                ctx.fillStyle = KEY_DAY_LABEL_COLOR;

                meta.data.forEach(function (point, index) {
                    if (!sorted[index]) return;
                    var day = sorted[index].day;
                    if (KEY_DAY_SET[day]) {
                        var val = dataset.data[index];
                        var text = formatFn ? formatFn(val) : val.toLocaleString();
                        var x = point.x;
                        var y = point.y - LABEL_OFFSET_ABOVE;
                        if (y < LABEL_MIN_Y) y = point.y + LABEL_OFFSET_BELOW;
                        ctx.fillText(text, x, y);
                    }
                });

                ctx.restore();
            }
        };
    }

    /**
     * 获取通用的 Chart.js 配置选项
     *
     * @param {Array<Object>} sorted - 排序后的数据
     * @param {string} xLabel - X 轴标题
     * @param {string} yLabel - Y 轴标题
     * @param {Function} tooltipLabelFn - tooltip 标签格式化函数
     * @param {Function} yTickFn - Y 轴刻度格式化函数
     * @returns {Object} Chart.js options 配置
     */
    function _getChartOptions(sorted, xLabel, yLabel, tooltipLabelFn, yTickFn) {
        var labels = sorted.map(function (p) { return p.day; });

        return {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: {
                    display: false,
                    position: 'top',
                    // 禁用点击图例隐藏数据集的默认行为（单数据集图表点击后曲线会消失）
                    onClick: function () {},
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
                        title: function (tooltipItems) {
                            return '第 ' + tooltipItems[0].label + ' 天';
                        },
                        label: tooltipLabelFn || function (context) {
                            var label = context.dataset.label || '';
                            return label + ': ' + context.parsed.y.toLocaleString();
                        }
                    }
                }
            },
            scales: {
                x: {
                    title: { display: true, text: xLabel || '天数', font: { weight: 'bold' } },
                    grid: { color: COLORS.gridColor },
                    ticks: {
                        color: COLORS.textColor,
                        font: { size: 11 },
                        maxTicksLimit: 20,
                        callback: function (value, index) {
                            var day = labels[index];
                            // 数据量少于30条时全部显示，否则只显示关键天数
                            if (sorted.length <= 30 || KEY_DAY_SET[day]) return day;
                            return '';
                        }
                    }
                },
                y: {
                    title: { display: true, text: yLabel || '数值', font: { weight: 'bold' } },
                    beginAtZero: true,
                    grid: { color: COLORS.gridColor },
                    ticks: {
                        color: COLORS.textColor,
                        font: { size: 11 },
                        callback: yTickFn || function (value) {
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
     * 渲染增强型折线图（内部通用函数）
     * 支持关键天数高亮和数值标签
     *
     * @param {string} canvasId - Canvas 元素 ID
     * @param {Array<Object>} data - 数据 [{day:1, value:1500}, ...]
     * @param {string} label - 数据集标签名称
     * @param {string} lineColor - 线条颜色
     * @param {string} fillColor - 填充颜色
     * @param {number} lineWidth - 线条宽度
     * @param {Function} formatFn - 关键天数标签格式化函数
     * @param {Object} chartOptions - 图表选项
     * @param {string} pointColor - 普通点颜色
     */
    function _renderEnhancedChart(canvasId, data, label, lineColor, fillColor, lineWidth, formatFn, chartOptions, pointColor) {
        destroy(canvasId);

        var canvas = document.getElementById(canvasId);
        if (!canvas) return;

        var sorted = _sortData(data);
        if (!sorted.length) return;

        var ctx = canvas.getContext('2d');
        var labels = sorted.map(function (p) { return p.day; });
        var values = sorted.map(function (p) { return p.value; });

        // 关键天数使用高亮样式
        var pColor = pointColor || lineColor;
        var pointRadii = sorted.map(function (p) {
            return KEY_DAY_SET[p.day] ? 3 : 0;
        });
        var pointBgColors = sorted.map(function (p) {
            return KEY_DAY_SET[p.day] ? KEY_DAY_POINT_COLOR : pColor;
        });

        var config = {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: label,
                    data: values,
                    borderColor: lineColor,
                    backgroundColor: fillColor,
                    borderWidth: lineWidth || 2,
                    pointRadius: pointRadii,
                    pointBackgroundColor: pointBgColors,
                    pointBorderColor: pointBgColors,
pointHoverRadius: 4,
                    fill: true,
                    tension: 0.3
                }]
            },
            options: chartOptions,
            plugins: [_buildKeyDayLabelsPlugin(sorted, formatFn)]
        };

        chartInstances[canvasId] = new Chart(ctx, config);
    }

    /**
     * 渲染单个标签页的 DNU 和 DAU 两个独立折线图
     *
     * @param {string} dnuCanvasId - DNU 图表的 Canvas 元素 ID
     * @param {string} dauCanvasId - DAU 图表的 Canvas 元素 ID
     * @param {Array<Object>} dnuData - DNU 数据 [{day:1, value:1500}, ...]
     * @param {Array<Object>} dauData - DAU 计算结果 [{day:1, value:...}, ...]
     * @param {string} tabName - 标签名称（用于图表标题）
     */
    function renderDauChart(dnuCanvasId, dauCanvasId, dnuData, dauData, tabName) {
        var dnuSorted = _sortData(dnuData);
        var dauSorted = _sortData(dauData);

        // DNU 图表 - 数值格式化为整数
        var dnuFormatFn = function (val) { return val.toLocaleString(); };
        var dnuTooltipFn = function (context) {
            var label = context.dataset.label || '';
            return label + ': ' + context.parsed.y.toLocaleString();
        };
        var dnuYTickFn = function (value) {
            if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
            if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
            return value;
        };
var dnuOptions = _getChartOptions(dnuSorted, '天数 (Day)', 'DNU', dnuTooltipFn, dnuYTickFn);

        _renderEnhancedChart(
            dnuCanvasId, dnuData,
            'DNU',
            COLORS.dnuLine, COLORS.dnuFill, 2,
            dnuFormatFn, dnuOptions, COLORS.dnuLine
        );

        // DAU 图表 - 数值格式化为整数（仅显示取整，不影响真实数据）
        var dauFormatFn = function (val) { return Math.round(val).toLocaleString(); };
        var dauTooltipFn = function (context) {
            var label = context.dataset.label || '';
            return label + ': ' + Math.round(context.parsed.y).toLocaleString();
        };
        var dauYTickFn = function (value) {
            var v = Math.round(value);
            if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
            if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
            return v;
        };
var dauOptions = _getChartOptions(dauSorted, '天数 (Day)', 'DAU', dauTooltipFn, dauYTickFn);

        _renderEnhancedChart(
            dauCanvasId, dauData,
            'DAU',
            COLORS.dauLine, COLORS.dauFill, 2.5,
            dauFormatFn, dauOptions, COLORS.dauLine
        );
    }

    /**
     * 渲染全局汇总图表
     * 展示所有标签页数据累加后的 DNU 总和曲线和 DAU 总和曲线
     *
     * @param {string} dnuCanvasId - DNU 汇总图表的 Canvas 元素 ID
     * @param {string} dauCanvasId - DAU 汇总图表的 Canvas 元素 ID
     * @param {Array<Object>} totalDnu - 累加 DNU [{day:1, value:...}, ...]
     * @param {Array<Object>} totalDau - 累加 DAU [{day:1, value:...}, ...]
     */
    function renderTotalChart(dnuCanvasId, dauCanvasId, totalDnu, totalDau) {
        var dnuSorted = _sortData(totalDnu);
        var dauSorted = _sortData(totalDau);

        // DNU 汇总图表
        var dnuFormatFn = function (val) { return val.toLocaleString(); };
        var dnuTooltipFn = function (context) {
            var label = context.dataset.label || '';
            return label + ': ' + context.parsed.y.toLocaleString();
        };
        var dnuYTickFn = function (value) {
            if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
            if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
            return value;
        };
var dnuOptions = _getChartOptions(dnuSorted, '天数 (Day)', 'DNU 汇总', dnuTooltipFn, dnuYTickFn);

        _renderEnhancedChart(
            dnuCanvasId, totalDnu,
            'DNU 汇总',
            COLORS.totalDnuLine, COLORS.totalDnuFill, 2,
            dnuFormatFn, dnuOptions, COLORS.totalDnuLine
        );

        // DAU 汇总图表 - 数值格式化为整数（仅显示取整，不影响真实数据）
        var dauFormatFn = function (val) { return Math.round(val).toLocaleString(); };
        var dauTooltipFn = function (context) {
            var label = context.dataset.label || '';
            return label + ': ' + Math.round(context.parsed.y).toLocaleString();
        };
        var dauYTickFn = function (value) {
            var v = Math.round(value);
            if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
            if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
            return v;
        };
var dauOptions = _getChartOptions(dauSorted, '天数 (Day)', 'DAU 汇总', dauTooltipFn, dauYTickFn);

        _renderEnhancedChart(
            dauCanvasId, totalDau,
            'DAU 汇总',
            COLORS.totalDauLine, COLORS.totalDauFill, 2.5,
            dauFormatFn, dauOptions, COLORS.totalDauLine
        );
    }

    /**
     * 切换数据视图（列表 / 图表）
     *
     * @param {string} chartType - 图表类型 ('dnu' | 'dau')
     * @param {number} tabIndex - 标签页索引
     * @param {string} view - 视图类型 ('list' | 'chart')
     * @param {HTMLElement} btn - 触发按钮
     */
    function switchDataView(chartType, tabIndex, view, btn) {
        if (!btn) return;

        // 更新按钮激活状态
        var group = btn.closest('.data-view-toggle');
        if (group) {
            group.querySelectorAll('.btn-data-view').forEach(function (b) {
                b.classList.remove('active');
            });
            btn.classList.add('active');
        }

        // 根据 chartType 构建正确的 ID
        var canvasId, chartWrapId, tableWrapId;
        if (chartType === 'totalDnu') {
            canvasId = 'totalChartCanvasDnu';
            chartWrapId = 'totalChartCanvasDnuWrap';
            tableWrapId = 'totalDnuTableWrap_total';
        } else if (chartType === 'totalDau') {
            canvasId = 'totalChartCanvasDau';
            chartWrapId = 'totalChartCanvasDauWrap';
            tableWrapId = 'totalDauTableWrap_total';
        } else {
            canvasId = 'chartCanvas' + (chartType === 'dnu' ? 'Dnu' : 'Dau') + '_' + tabIndex;
            chartWrapId = canvasId + 'Wrap';
            tableWrapId = chartType + 'TableWrap_' + tabIndex;
        }

        var chartWrapEl = document.getElementById(chartWrapId);
        var tableWrapEl = document.getElementById(tableWrapId);
        var isListView = view === 'list';

        if (tableWrapEl) tableWrapEl.style.display = isListView ? '' : 'none';
        if (chartWrapEl) chartWrapEl.style.display = isListView ? 'none' : '';
    }

    /**
     * 如果图表视图当前可见，则刷新图表
     *
     * @param {string} canvasId - Canvas 元素 ID
     * @param {Array<Object>} data - 数据
     * @param {string} label - 标签
     * @param {string} lineColor - 线条颜色
     * @param {string} fillColor - 填充颜色
     */
    function refreshChartIfVisible(canvasId, data, label, lineColor, fillColor) {
        var chartWrapEl = document.getElementById(canvasId + 'Wrap');
        if (chartWrapEl && chartWrapEl.style.display !== 'none') {
            var sorted = _sortData(data);
            var formatFn = function (val) { return Math.round(val).toLocaleString(); };
            var tooltipFn = function (context) {
                var lbl = context.dataset.label || '';
                return lbl + ': ' + Math.round(context.parsed.y).toLocaleString();
            };
            var yTickFn = function (value) {
                var v = Math.round(value);
                if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
                if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
                return v;
            };
            var options = _getChartOptions(sorted, '天数 (Day)', label, tooltipFn, yTickFn);
            _renderEnhancedChart(canvasId, data, label, lineColor, fillColor, 2, formatFn, options, lineColor);
        }
    }

    /**
     * 重置所有数据视图到列表模式
     */
    function resetAllDataViews() {
        // 查找所有视图切换按钮组，将列表按钮设为激活
        var toggleGroups = document.querySelectorAll('.data-view-toggle');
        toggleGroups.forEach(function (group) {
            group.querySelectorAll('.btn-data-view').forEach(function (b) {
                var isListBtn = b.getAttribute('data-view') === 'list';
                b.classList.toggle('active', isListBtn);
            });
        });

        // 隐藏所有图表容器，显示所有表格容器
        var chartWraps = document.querySelectorAll('.data-chart-wrap');
        chartWraps.forEach(function (el) { el.style.display = 'none'; });

        var tableWraps = document.querySelectorAll('.data-table-wrap');
        tableWraps.forEach(function (el) { el.style.display = ''; });

        destroyAllCharts();
    }

    // ========== 公开 API ==========
    IAA.chart = {
        renderDauChart: renderDauChart,
        renderTotalChart: renderTotalChart,
        destroy: destroy,
        destroyAllCharts: destroyAllCharts,
        switchDataView: switchDataView,
        refreshChartIfVisible: refreshChartIfVisible,
        resetAllDataViews: resetAllDataViews
    };

})(window);