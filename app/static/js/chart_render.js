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
 *   - 横轴使用日期类型，支持日期范围筛选和日/月视角切换
 *   - 月视角下 DNU 采用求和，DAU 采用平均值
 */

;(function (global) {
    'use strict';

    var IAA = global.IAA;

    // 存储所有 Chart 实例，key 为 canvas ID
    var chartInstances = {};

    // 存储每个图表的原始数据和配置，用于视角切换和日期范围筛选时重新渲染
    var chartDataStore = {};

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

    // ========== 日期工具函数 ==========

    /**
     * 将基准日期和相对天数转换为实际日期字符串 (YYYY-MM-DD)
     * @param {string} baseDate - 基准日期 YYYY-MM-DD
     * @param {number} day - 相对天数（从1开始）
     * @returns {string} 实际日期 YYYY-MM-DD
     */
    function _dayToDate(baseDate, day) {
        var d = new Date(baseDate + 'T00:00:00');
        d.setDate(d.getDate() + (day - 1));
        var yyyy = d.getFullYear();
        var mm = String(d.getMonth() + 1).padStart(2, '0');
        var dd = String(d.getDate()).padStart(2, '0');
        return yyyy + '-' + mm + '-' + dd;
    }

    /**
     * 格式化日期为简短显示格式 (MM-DD 或 YYYY-MM)
     * @param {string} dateStr - YYYY-MM-DD 格式日期
     * @param {string} viewMode - 'day' 或 'month'
     * @returns {string} 格式化后的日期
     */
    function _formatDateLabel(dateStr, viewMode) {
        if (viewMode === 'month') {
            return dateStr.substring(0, 7); // YYYY-MM
        }
        return dateStr.substring(5); // MM-DD
    }

    /**
     * 获取日期的月份键 (YYYY-MM)
     * @param {string} dateStr - YYYY-MM-DD 格式日期
     * @returns {string} YYYY-MM
     */
    function _getMonthKey(dateStr) {
        return dateStr.substring(0, 7);
    }

    /**
     * 将日数据聚合为月数据
     * @param {Array<Object>} data - [{day, value, date}, ...]
     * @param {string} aggregateMode - 'sum'（DNU求和）或 'avg'（DAU平均值）
     * @returns {Array<Object>} 月度聚合数据 [{date, value}, ...]
     */
    function _aggregateToMonthly(data, aggregateMode) {
        if (!data || !data.length) return [];

        var monthMap = {};
        var monthOrder = [];

        for (var i = 0; i < data.length; i++) {
            var item = data[i];
            var monthKey = _getMonthKey(item.date);

            if (!monthMap[monthKey]) {
                monthMap[monthKey] = { sum: 0, count: 0 };
                monthOrder.push(monthKey);
            }
            monthMap[monthKey].sum += item.value;
            monthMap[monthKey].count += 1;
        }

        var result = [];
        for (var j = 0; j < monthOrder.length; j++) {
            var key = monthOrder[j];
            var entry = monthMap[key];
            var value = aggregateMode === 'avg'
                ? Math.round(entry.sum / entry.count * 100) / 100
                : Math.round(entry.sum * 100) / 100;
            result.push({ date: key, value: value });
        }

        return result;
    }

    /**
     * 根据日期范围筛选数据
     * @param {Array<Object>} data - [{day, value, date}, ...]
     * @param {string|null} startDate - 起始日期 YYYY-MM-DD
     * @param {string|null} endDate - 结束日期 YYYY-MM-DD
     * @returns {Array<Object>} 筛选后的数据
     */
    function _filterByDateRange(data, startDate, endDate) {
        if (!startDate && !endDate) return data;
        if (!data || !data.length) return [];

        return data.filter(function (item) {
            if (startDate && item.date < startDate) return false;
            if (endDate && item.date > endDate) return false;
            return true;
        });
    }

    /**
     * 为数据添加日期字段
     * @param {Array<Object>} data - [{day, value}, ...]
     * @param {string} baseDate - 基准日期 YYYY-MM-DD
     * @returns {Array<Object>} [{day, value, date}, ...]
     */
    function _enrichWithDates(data, baseDate) {
        if (!data || !data.length || !baseDate) return data;

        return data.map(function (item) {
            return {
                day: item.day,
                value: item.value,
                date: _dayToDate(baseDate, item.day)
            };
        });
    }

    // ========== 图表实例管理 ==========

    /**
     * 销毁指定 Canvas 上的 Chart 实例
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
            chartInstances[key].destroy();
            delete chartInstances[key];
        });
    }

    // ========== 数据排序 ==========

    /**
     * 从 "天数-数据" 对象数组中提取排序后的数据
     * @param {Array<Object>} dayValuePairs - [{day: 1, value: 1500}, ...]
     * @returns {Array<Object>} 按天数排序后的数组
     */
    function _sortData(dayValuePairs) {
        if (!dayValuePairs || !dayValuePairs.length) return [];
        return dayValuePairs.slice().sort(function (a, b) {
            return a.day - b.day;
        });
    }

    // ========== 图表配置构建 ==========

    /**
     * 获取通用的 Chart.js 配置选项（日期横轴版本）
     * @param {string} xLabel - X 轴标题
     * @param {string} yLabel - Y 轴标题
     * @param {Function} tooltipLabelFn - tooltip 标签格式化函数
     * @param {Function} yTickFn - Y 轴刻度格式化函数
     * @param {string} viewMode - 'day' 或 'month'
     * @returns {Object} Chart.js options 配置
     */
    function _getChartOptions(xLabel, yLabel, tooltipLabelFn, yTickFn, viewMode) {
        return {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: 'rgba(32, 33, 36, 0.9)',
                    titleFont: { size: 13 },
                    bodyFont: { size: 12 },
                    padding: 10,
                    cornerRadius: 6,
                    callbacks: {
                        title: function (tooltipItems) {
                            var label = tooltipItems[0].label || '';
                            if (viewMode === 'month') {
                                return label + ' 月';
                            }
                            return label;
                        },
                        label: tooltipLabelFn || function (context) {
                            var lbl = context.dataset.label || '';
                            return lbl + ': ' + context.parsed.y.toLocaleString();
                        }
                    }
                }
            },
            scales: {
                x: {
                    title: { display: true, text: xLabel || '日期', font: { weight: 'bold' } },
                    grid: { color: COLORS.gridColor },
                    ticks: {
                        color: COLORS.textColor,
                        font: { size: 11 },
                        maxRotation: 45,
                        minRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: viewMode === 'month' ? 24 : 30
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
     * @param {string} canvasId - Canvas 元素 ID
     * @param {Array<string>} labels - X 轴标签数组
     * @param {Array<number>} values - Y 轴数据数组
     * @param {string} label - 数据集标签名称
     * @param {string} lineColor - 线条颜色
     * @param {string} fillColor - 填充颜色
     * @param {number} lineWidth - 线条宽度
     * @param {Object} chartOptions - 图表选项
     */
    function _renderChart(canvasId, labels, values, label, lineColor, fillColor, lineWidth, chartOptions) {
        destroy(canvasId);

        var canvas = document.getElementById(canvasId);
        if (!canvas) return;
        if (!labels.length) return;

        var ctx = canvas.getContext('2d');

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
                    pointRadius: values.length <= 60 ? 2 : 0,
                    pointBackgroundColor: lineColor,
                    pointBorderColor: lineColor,
                    pointHoverRadius: 4,
                    fill: true,
                    tension: 0.3
                }]
            },
            options: chartOptions
        };

        chartInstances[canvasId] = new Chart(ctx, config);
    }

    /**
     * 处理数据并渲染单个图表（支持视角切换和日期范围筛选）
     * @param {string} canvasId - Canvas 元素 ID
     * @param {Array<Object>} rawData - 原始数据 [{day, value, date}, ...]
     * @param {string} label - 数据集标签
     * @param {string} lineColor - 线条颜色
     * @param {string} fillColor - 填充颜色
     * @param {number} lineWidth - 线条宽度
     * @param {string} viewMode - 'day' 或 'month'
     * @param {string} aggregateMode - 'sum' 或 'avg'
     * @param {string|null} startDate - 筛选起始日期
     * @param {string|null} endDate - 筛选结束日期
     */
    function _processAndRender(canvasId, rawData, label, lineColor, fillColor, lineWidth, viewMode, aggregateMode, startDate, endDate) {
        if (!rawData || !rawData.length) return;

        // 1. 日期范围筛选
        var filtered = _filterByDateRange(rawData, startDate, endDate);
        if (!filtered.length) return;

        // 2. 视角聚合
        var displayData;
        var labels;
        var values;

        if (viewMode === 'month') {
            displayData = _aggregateToMonthly(filtered, aggregateMode);
            labels = displayData.map(function (d) { return d.date; });
            values = displayData.map(function (d) { return d.value; });
        } else {
            labels = filtered.map(function (d) { return _formatDateLabel(d.date, 'day'); });
            values = filtered.map(function (d) { return d.value; });
        }

        // 3. 构建图表选项
        var xLabel = viewMode === 'month' ? '月份' : '日期';
        var isDAU = aggregateMode === 'avg';
        var yLabel = label;

        var tooltipFn = function (context) {
            var lbl = context.dataset.label || '';
            var val = isDAU ? Math.round(context.parsed.y).toLocaleString() : context.parsed.y.toLocaleString();
            return lbl + ': ' + val;
        };

        var yTickFn = function (value) {
            var v = isDAU ? Math.round(value) : value;
            if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
            if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
            return v;
        };

        var chartOptions = _getChartOptions(xLabel, yLabel, tooltipFn, yTickFn, viewMode);

        // 4. 渲染
        _renderChart(canvasId, labels, values, label, lineColor, fillColor, lineWidth, chartOptions);
    }

    // ========== 公开渲染函数 ==========

    /**
     * 渲染一对 DNU + DAU 折线图的通用内部函数
     * 负责排序、日期enrichment、数据存储和渲染，消除 renderDauChart / renderTotalChart 的重复逻辑
     *
     * @param {string} dnuCanvasId - DNU 图表的 Canvas 元素 ID
     * @param {string} dauCanvasId - DAU 图表的 Canvas 元素 ID
     * @param {Array<Object>} dnuData - DNU 数据
     * @param {Array<Object>} dauData - DAU 数据
     * @param {string} dnuLabel - DNU 数据集标签
     * @param {string} dauLabel - DAU 数据集标签
     * @param {Object} dnuColors - DNU 配色 {line, fill}
     * @param {Object} dauColors - DAU 配色 {line, fill}
     * @param {string} baseDate - 基准日期 YYYY-MM-DD
     */
    function _renderChartPair(dnuCanvasId, dauCanvasId, dnuData, dauData, dnuLabel, dauLabel, dnuColors, dauColors, baseDate) {
        var dnuSorted = _sortData(dnuData);
        var dauSorted = _sortData(dauData);

        // 为数据添加日期字段
        var dnuWithDates = baseDate ? _enrichWithDates(dnuSorted, baseDate) : dnuSorted;
        var dauWithDates = baseDate ? _enrichWithDates(dauSorted, baseDate) : dauSorted;

        // 存储原始数据供后续视角切换和日期范围筛选使用
        chartDataStore[dnuCanvasId] = {
            rawData: dnuWithDates,
            label: dnuLabel,
            lineColor: dnuColors.line,
            fillColor: dnuColors.fill,
            lineWidth: 2,
            aggregateMode: 'sum',
            baseDate: baseDate
        };
        chartDataStore[dauCanvasId] = {
            rawData: dauWithDates,
            label: dauLabel,
            lineColor: dauColors.line,
            fillColor: dauColors.fill,
            lineWidth: 2.5,
            aggregateMode: 'avg',
            baseDate: baseDate
        };

        // 默认以日视角渲染
        _processAndRender(dnuCanvasId, dnuWithDates, dnuLabel,
            dnuColors.line, dnuColors.fill, 2, 'day', 'sum', null, null);

        _processAndRender(dauCanvasId, dauWithDates, dauLabel,
            dauColors.line, dauColors.fill, 2.5, 'day', 'avg', null, null);
    }

    /**
     * 渲染单个标签页的 DNU 和 DAU 两个独立折线图
     *
     * @param {string} dnuCanvasId - DNU 图表的 Canvas 元素 ID
     * @param {string} dauCanvasId - DAU 图表的 Canvas 元素 ID
     * @param {Array<Object>} dnuData - DNU 数据 [{day:1, value:1500}, ...]
     * @param {Array<Object>} dauData - DAU 计算结果 [{day:1, value:...}, ...]
     * @param {string} tabName - 标签名称（保留参数以兼容外部调用）
     * @param {string} baseDate - 基准日期 YYYY-MM-DD（DNU 最早的起始日期）
     */
    function renderDauChart(dnuCanvasId, dauCanvasId, dnuData, dauData, tabName, baseDate) {
        _renderChartPair(
            dnuCanvasId, dauCanvasId, dnuData, dauData,
            'DNU', 'DAU',
            { line: COLORS.dnuLine, fill: COLORS.dnuFill },
            { line: COLORS.dauLine, fill: COLORS.dauFill },
            baseDate
        );
    }

    /**
     * 渲染全局汇总图表
     *
     * @param {string} dnuCanvasId - DNU 汇总图表的 Canvas 元素 ID
     * @param {string} dauCanvasId - DAU 汇总图表的 Canvas 元素 ID
     * @param {Array<Object>} totalDnu - 累加 DNU [{day:1, value:...}, ...]
     * @param {Array<Object>} totalDau - 累加 DAU [{day:1, value:...}, ...]
     * @param {string} baseDate - 基准日期 YYYY-MM-DD
     */
    function renderTotalChart(dnuCanvasId, dauCanvasId, totalDnu, totalDau, baseDate) {
        _renderChartPair(
            dnuCanvasId, dauCanvasId, totalDnu, totalDau,
            'DNU 汇总', 'DAU 汇总',
            { line: COLORS.totalDnuLine, fill: COLORS.totalDnuFill },
            { line: COLORS.totalDauLine, fill: COLORS.totalDauFill },
            baseDate
        );
    }

    /**
     * 应用视角切换和日期范围筛选，重新渲染指定的图表
     * 此函数由工具栏控件调用
     *
     * @param {string} canvasId - Canvas 元素 ID
     * @param {string} viewMode - 'day' 或 'month'
     * @param {string|null} startDate - 筛选起始日期
     * @param {string|null} endDate - 筛选结束日期
     */
    function applyChartFilter(canvasId, viewMode, startDate, endDate) {
        var store = chartDataStore[canvasId];
        if (!store) return;

        _processAndRender(
            canvasId,
            store.rawData,
            store.label,
            store.lineColor,
            store.fillColor,
            store.lineWidth,
            viewMode || 'day',
            store.aggregateMode,
            startDate || null,
            endDate || null
        );
    }

    /**
     * 批量应用视角切换和日期范围筛选到一组图表
     * 用于同时更新同一区域的 DNU 和 DAU 图表
     *
     * @param {Array<string>} canvasIds - Canvas 元素 ID 数组
     * @param {string} viewMode - 'day' 或 'month'
     * @param {string|null} startDate - 筛选起始日期
     * @param {string|null} endDate - 筛选结束日期
     */
    function applyChartFilterBatch(canvasIds, viewMode, startDate, endDate) {
        for (var i = 0; i < canvasIds.length; i++) {
            applyChartFilter(canvasIds[i], viewMode, startDate, endDate);
        }
    }

    /**
     * 获取经过日期筛选和视角聚合处理后的数据（供列表视图使用）
     *
     * @param {string} canvasId - Canvas 元素 ID
     * @param {string} viewMode - 'day' 或 'month'
     * @param {string|null} startDate - 筛选起始日期
     * @param {string|null} endDate - 筛选结束日期
     * @returns {Object|null} {labels, values, aggregateMode} 或 null
     */
    function getProcessedData(canvasId, viewMode, startDate, endDate) {
        var store = chartDataStore[canvasId];
        if (!store || !store.rawData || !store.rawData.length) return null;

        // 1. 日期范围筛选
        var filtered = _filterByDateRange(store.rawData, startDate, endDate);
        if (!filtered.length) return null;

        // 2. 视角聚合
        var labels, values;
        if (viewMode === 'month') {
            var displayData = _aggregateToMonthly(filtered, store.aggregateMode);
            labels = displayData.map(function (d) { return d.date; });
            values = displayData.map(function (d) { return d.value; });
        } else {
            labels = filtered.map(function (d) { return d.date; });
            values = filtered.map(function (d) { return d.value; });
        }

        return {
            labels: labels,
            values: values,
            aggregateMode: store.aggregateMode
        };
    }

    /**
     * 获取指定图表的日期范围（用于初始化日期选择器）
     * 数据已按天数排序，直接取首尾元素的日期即可，无需再次排序
     *
     * @param {string} canvasId - Canvas 元素 ID
     * @returns {Object|null} {minDate, maxDate} 或 null
     */
    function getChartDateRange(canvasId) {
        var store = chartDataStore[canvasId];
        if (!store || !store.rawData || !store.rawData.length) return null;

        var rawData = store.rawData;
        var firstDate = rawData[0].date;
        var lastDate = rawData[rawData.length - 1].date;

        if (!firstDate || !lastDate) return null;

        return {
            minDate: firstDate,
            maxDate: lastDate
        };
    }

    // ========== 数据视图切换 ==========

    /**
     * 切换数据视图（列表 / 图表）
     *
     * @param {string} chartType - 图表类型 ('dnu' | 'dau' | 'totalDnu' | 'totalDau')
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
     * 所有渲染参数从 chartDataStore 中读取，无需外部传入
     *
     * @param {string} canvasId - Canvas 元素 ID
     */
    function refreshChartIfVisible(canvasId) {
        var chartWrapEl = document.getElementById(canvasId + 'Wrap');
        if (chartWrapEl && chartWrapEl.style.display !== 'none') {
            var store = chartDataStore[canvasId];
            if (store) {
                _processAndRender(canvasId, store.rawData, store.label,
                    store.lineColor, store.fillColor, store.lineWidth,
                    'day', store.aggregateMode, null, null);
            }
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
        resetAllDataViews: resetAllDataViews,
        applyChartFilter: applyChartFilter,
        applyChartFilterBatch: applyChartFilterBatch,
        getChartDateRange: getChartDateRange,
        getProcessedData: getProcessedData
    };

})(window);