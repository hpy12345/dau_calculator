/**
 * workspace.js - 工作区 Tabs、表单交互与数据收发
 * =================================================
 * 挂载在 window.IAA.workspace 命名空间下。
 * 使用 ES5 IIFE 模块化模式，通过原生 JS + Fetch API 实现
 * 不依赖 Vue/React 等框架的传统前后端交互逻辑。
 *
 * 核心职责：
 *   1. 标签页 (Tabs) 的切换、新增、删除
 *   2. DNU 数据按时间段设置（日均固定值 / 线性变化）
 *   3. 留存率数据录入管理（手动输入 / Excel 导入）
 *   4. 从 DOM 中收集 "天数-数据" 对应格式的数据
 *   5. 通过 fetch 异步提交 JSON 到后端 API
 *   6. 接收计算结果后调用 chart 模块渲染图表
 *   7. 统一数据展示行为：无论新导入还是加载已保存数据，均以预览模式展示
 */

;(function (global) {
    'use strict';

    var IAA = global.IAA;
    var utils = IAA.utils;

    // ========== 常量定义 ==========

    /** 预览模式下最大展示行数 */
    var MAX_PREVIEW_ROWS = 30;

    /** 数据录入模式枚举（仅留存率使用） */
    var INPUT_MODE = {
        MANUAL: 'manual',
        IMPORT: 'import'
    };

    // ========== 模块内部状态 ==========
    var state = {
        projectId: '',
        projectName: '',
        activeTabIndex: 0,
        tabCount: 0
    };

    /**
     * 导入数据缓存：存储完整的导入/加载数据（不受展示行数限制）
     * 结构：{ 'retention': { 0: [...], 1: [...] } }
     * 注意：DNU 不再使用此缓存，改为从时间段实时生成
     */
    var _importedData = {};

    /**
     * 各标签页各数据类型的当前录入模式（仅留存率使用）
     * 结构：{ 'retention': { 0: 'import' } }
     */
    var _inputModes = {};

    /**
     * DNU 时间段计数器：记录每个标签页的时间段自增索引
     * 结构：{ 0: 1, 1: 0 }
     */
    var _dnuSegmentCounters = {};

    // ==================== 日期辅助函数 ====================

    /** 每日毫秒数常量，避免重复计算 */
    var MS_PER_DAY = 1000 * 60 * 60 * 24;

    /**
     * 将 Date 对象格式化为 YYYY-MM-DD 字符串
     * @param {Date} d - Date 对象
     * @returns {string} YYYY-MM-DD 格式的日期
     */
    function _formatDate(d) {
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    /**
     * 获取今天的日期字符串（YYYY-MM-DD 格式）
     * @returns {string}
     */
    function _getTodayStr() {
        return _formatDate(new Date());
    }

    /**
     * 将日期字符串偏移指定天数
     * @param {string} dateStr - YYYY-MM-DD 格式的日期
     * @param {number} offsetDays - 偏移天数（正数为未来，负数为过去）
     * @returns {string} YYYY-MM-DD 格式的日期
     */
    function _offsetDateStr(dateStr, offsetDays) {
        var d = new Date(dateStr + 'T00:00:00');
        d.setDate(d.getDate() + offsetDays);
        return _formatDate(d);
    }

    /**
     * 初始化工作区
     * 页面加载完成后自动执行，从隐藏字段读取项目信息，
     * 并对已保存的数据执行统一的预览模式渲染
     */
    function init() {
        state.projectId = (utils.$('#projectId') || {}).value || '';
        state.projectName = (utils.$('#projectName') || {}).value || '';
        state.tabCount = utils.$$('.tab-item', utils.$('#tabsBar')).length;
        state.activeTabIndex = 0;

        // 加载已保存的项目数据，统一以预览模式渲染
        _initSavedData();

        // 加载已保存的留存率曲线列表
        _refreshAllSavedCurvesLists();
    }

    /**
     * 初始化已保存的项目数据
     * 从页面内嵌的 JSON 数据中读取，对有数据的标签页执行预览模式渲染
     */
    function _initSavedData() {
        var dataScript = document.getElementById('savedProjectData');
        if (!dataScript) return;

        var project;
        try {
            project = JSON.parse(dataScript.textContent);
        } catch (e) {
            return;
        }

        if (!project || !project.tabs) return;

        for (var i = 0; i < project.tabs.length; i++) {
            var tab = project.tabs[i];

            // 如果有 DNU 数据，反向解析为时间段并渲染
            if (tab.dnu_data && tab.dnu_data.length > 0) {
                _loadDnuDataAsSegments(i, tab.dnu_data);
            }

            // 如果有留存率数据，以预览模式展示
            if (tab.retention_data && tab.retention_data.length > 0) {
                _renderImportPreview('retention', i, tab.retention_data);
                // 自动切换到导入模式
                switchInputMode('retention', i, INPUT_MODE.IMPORT);
                // 注：保存曲线按钮已集成到导入预览的操作栏中，随预览一起显示
            }
        }
    }

    /**
     * 将已保存的 DNU 数据加载为时间段
     * 将 [{day:1, value:100}, {day:2, value:100}, ...] 格式的数据
     * 反向解析为一个覆盖全部天数的日均固定值时间段
     *
     * @param {number} tabIndex - 标签页索引
     * @param {Array<Object>} dnuData - DNU 数据数组
     */
    function _loadDnuDataAsSegments(tabIndex, dnuData) {
        if (!dnuData || dnuData.length === 0) return;

        var container = document.getElementById('dnuSegments_' + tabIndex);
        if (!container) return;

        // 清空现有时间段
        container.innerHTML = '';
        _dnuSegmentCounters[tabIndex] = 0;

        // 按天数排序
        var sorted = dnuData.slice().sort(function (a, b) { return a.day - b.day; });

        // 智能分段：将连续且数值相同的天数合并为一个固定值时间段，
        // 连续且数值线性变化的合并为线性时间段
        var segments = _detectSegments(sorted);

        // 将天数序号转换为日期（以今天为 day=1 的基准日期）
        var baseDate = _getTodayStr();
        for (var i = 0; i < segments.length; i++) {
            var seg = segments[i];
            seg.startDate = _offsetDateStr(baseDate, seg.start - 1);
            seg.endDate = _offsetDateStr(baseDate, seg.end - 1);
            _addDnuSegmentDOM(tabIndex, container, seg);
        }
    }

    /**
     * 智能检测数据中的时间段模式
     * 将连续天数的数据分组为固定值或线性变化的时间段
     *
     * @param {Array<Object>} sortedData - 按天数排序的数据
     * @returns {Array<Object>} 时间段数组，每项包含 {start, end, mode, value?, startValue?, endValue?}
     */
    function _detectSegments(sortedData) {
        if (!sortedData || sortedData.length === 0) return [];

        // 简单策略：将所有数据作为一个时间段
        // 检查是否所有值相同（固定值）或线性变化
        var startDay = sortedData[0].day;
        var endDay = sortedData[sortedData.length - 1].day;
        var firstValue = sortedData[0].value;
        var lastValue = sortedData[sortedData.length - 1].value;

        var allSame = true;
        for (var i = 1; i < sortedData.length; i++) {
            if (sortedData[i].value !== firstValue) {
                allSame = false;
                break;
            }
        }

        if (allSame) {
            return [{ start: startDay, end: endDay, mode: 'fixed', value: firstValue }];
        }

        // 检查是否为线性变化
        var isLinear = true;
        var dayCount = endDay - startDay;
        if (dayCount > 0) {
            for (var j = 0; j < sortedData.length; j++) {
                var expectedValue = firstValue + (lastValue - firstValue) * (sortedData[j].day - startDay) / dayCount;
                if (Math.abs(sortedData[j].value - expectedValue) > 1) {
                    isLinear = false;
                    break;
                }
            }
        }

        if (isLinear) {
            return [{ start: startDay, end: endDay, mode: 'linear', startValue: firstValue, endValue: lastValue }];
        }

        // 无法精确还原时，作为一个固定值时间段（取平均值）
        var sum = 0;
        for (var k = 0; k < sortedData.length; k++) {
            sum += sortedData[k].value;
        }
        var avg = Math.round(sum / sortedData.length);
        return [{ start: startDay, end: endDay, mode: 'fixed', value: avg }];
    }

    /**
     * 向指定标签页的时间段容器中添加一个时间段 DOM 元素
     *
     * @param {number} tabIndex - 标签页索引
     * @param {Element} container - 时间段容器 DOM
     * @param {Object} [segData] - 可选的预填数据
     */
    function _addDnuSegmentDOM(tabIndex, container, segData) {
        if (!_dnuSegmentCounters[tabIndex]) _dnuSegmentCounters[tabIndex] = 0;
        var segIndex = _dnuSegmentCounters[tabIndex]++;

        var mode = (segData && segData.mode) || 'fixed';
        var startDate = (segData && segData.startDate) || _getTodayStr();
        var endDate = (segData && segData.endDate) || _offsetDateStr(_getTodayStr(), 29);
        var fixedValue = (segData && segData.value) || '';
        var startValue = (segData && segData.startValue) || '';
        var endValue = (segData && segData.endValue) || '';

        var isFixed = (mode === 'fixed');

        var div = document.createElement('div');
        div.className = 'dnu-segment';
        div.setAttribute('data-segment-index', segIndex);
        div.innerHTML =
            '<div class="dnu-segment__row">' +
            '  <div class="dnu-segment__field">' +
            '    <label>起始日期</label>' +
            '    <input type="date" class="form-input dnu-seg-start" value="' + startDate + '">' +
            '  </div>' +
            '  <div class="dnu-segment__field">' +
            '    <label>结束日期</label>' +
            '    <input type="date" class="form-input dnu-seg-end" value="' + endDate + '">' +
            '  </div>' +
            '  <div class="dnu-segment__field">' +
            '    <label>数值模式</label>' +
            '    <select class="form-input dnu-seg-mode" onchange="IAA.workspace.onDnuModeChange(this)">' +
            '      <option value="fixed"' + (isFixed ? ' selected' : '') + '>日均固定值</option>' +
            '      <option value="linear"' + (!isFixed ? ' selected' : '') + '>线性变化</option>' +
            '    </select>' +
            '  </div>' +
            '  <div class="dnu-segment__field dnu-seg-fixed-fields"' + (!isFixed ? ' style="display:none;"' : '') + '>' +
            '    <label>DNU 数值</label>' +
            '    <input type="number" class="form-input dnu-seg-value" value="' + fixedValue + '" min="0" step="1" placeholder="如 1000">' +
            '  </div>' +
            '  <div class="dnu-segment__field dnu-seg-linear-fields"' + (isFixed ? ' style="display:none;"' : '') + '>' +
            '    <label>起始值</label>' +
            '    <input type="number" class="form-input dnu-seg-start-value" value="' + startValue + '" min="0" step="1" placeholder="如 100">' +
            '  </div>' +
            '  <div class="dnu-segment__field dnu-seg-linear-fields"' + (isFixed ? ' style="display:none;"' : '') + '>' +
            '    <label>结束值</label>' +
            '    <input type="number" class="form-input dnu-seg-end-value" value="' + endValue + '" min="0" step="1" placeholder="如 1000">' +
            '  </div>' +
            '  <div class="dnu-segment__field dnu-segment__field--curve">' +
            '    <label>📉 留存率曲线</label>' +
            '    <select class="form-input dnu-seg-curve" onchange="IAA.workspace.onSegmentCurveChange(this)">' +
            '      <option value="" disabled>无可用曲线</option>' +
            '    </select>' +
            '    <span class="dnu-seg-curve-hint dnu-seg-curve-hint--invalid">⚠️ 请先在左侧保存留存率曲线</span>' +
            '  </div>' +
            '  <div class="dnu-segment__actions">' +
'          <button class="btn btn-danger btn-sm" onclick="IAA.workspace.removeDnuSegment(this)" title="删除此时间段">删除</button>' +
            '  </div>' +
            '</div>';

        container.appendChild(div);

        // 刷新该时间段的曲线下拉列表
        _refreshSegmentCurveSelect(div.querySelector('.dnu-seg-curve'));
    }

    /**
     * 已缓存的曲线列表（供时间段曲线选择器使用）
     */
    var _cachedCurvesList = [];

    /**
     * 刷新单个时间段曲线选择器的选项
     * @param {Element} selectEl - 曲线选择下拉框元素
     */
    function _refreshSegmentCurveSelect(selectEl) {
        if (!selectEl) return;
        var currentValue = selectEl.value;
        var segment = selectEl.closest('.dnu-segment');
        var hint = selectEl.parentNode.querySelector('.dnu-seg-curve-hint');

        if (_cachedCurvesList.length === 0) {
            // 曲线库为空：显示"无可用曲线"禁用选项
            selectEl.innerHTML = '<option value="" disabled selected>无可用曲线</option>';
            if (hint) {
                hint.textContent = '⚠️ 请先在左侧保存留存率曲线';
                hint.className = 'dnu-seg-curve-hint dnu-seg-curve-hint--invalid';
            }
            if (segment) segment.classList.add('dnu-segment--invalid');
        } else {
            // 有曲线可用：构建选项列表
            selectEl.innerHTML = '';
            for (var i = 0; i < _cachedCurvesList.length; i++) {
                var c = _cachedCurvesList[i];
                var opt = document.createElement('option');
                opt.value = c.id;
                opt.textContent = c.name + '（' + c.data_count + ' 天）';
                selectEl.appendChild(opt);
            }

            // 恢复之前的选中值，若之前的值不存在则默认选中第一条
            var restored = false;
            if (currentValue) {
                for (var j = 0; j < selectEl.options.length; j++) {
                    if (selectEl.options[j].value === currentValue) {
                        selectEl.value = currentValue;
                        restored = true;
                        break;
                    }
                }
            }
            if (!restored) {
                selectEl.value = _cachedCurvesList[0].id;
            }

            // 更新提示文字
            var selectedOption = selectEl.options[selectEl.selectedIndex];
            if (hint && selectedOption) {
                hint.textContent = '✅ 已选择：' + selectedOption.textContent;
                hint.className = 'dnu-seg-curve-hint dnu-seg-curve-hint--selected';
            }
            if (segment) segment.classList.remove('dnu-segment--invalid');
        }
    }

    /**
     * 刷新所有时间段的曲线选择器
     */
    function _refreshAllSegmentCurveSelects() {
        var selects = document.querySelectorAll('.dnu-seg-curve');
        for (var i = 0; i < selects.length; i++) {
            _refreshSegmentCurveSelect(selects[i]);
        }
    }

    /**
     * 时间段曲线选择变更回调
     * @param {Element} selectEl - 曲线选择下拉框元素
     */
    function onSegmentCurveChange(selectEl) {
        var hint = selectEl.parentNode.querySelector('.dnu-seg-curve-hint');
        var segment = selectEl.closest('.dnu-segment');
        if (hint) {
            if (selectEl.value) {
                var selectedOption = selectEl.options[selectEl.selectedIndex];
                hint.textContent = '✅ 已选择：' + selectedOption.textContent;
                hint.className = 'dnu-seg-curve-hint dnu-seg-curve-hint--selected';
                if (segment) segment.classList.remove('dnu-segment--invalid');
            } else {
                hint.textContent = '⚠️ 请选择留存率曲线';
                hint.className = 'dnu-seg-curve-hint dnu-seg-curve-hint--invalid';
                if (segment) segment.classList.add('dnu-segment--invalid');
            }
        }
    }

    /**
     * 收集指定标签页中各时间段的分段数据（含各自的留存率曲线ID）
     * @param {number} tabIndex - 标签页索引
     * @returns {Array<Object>} 时间段数组，每项包含 {startDate, endDate, mode, value/startValue/endValue, curveId}
     */
    function _collectSegmentsInfo(tabIndex) {
        var container = document.getElementById('dnuSegments_' + tabIndex);
        if (!container) return [];

        var segments = container.querySelectorAll('.dnu-segment');
        var result = [];

        for (var i = 0; i < segments.length; i++) {
            var seg = segments[i];
            var startDateStr = seg.querySelector('.dnu-seg-start').value;
            var endDateStr = seg.querySelector('.dnu-seg-end').value;
            var mode = seg.querySelector('.dnu-seg-mode').value;
            var curveSelect = seg.querySelector('.dnu-seg-curve');
            var curveId = (curveSelect && curveSelect.value && !curveSelect.options[curveSelect.selectedIndex].disabled) ? curveSelect.value : '';

            if (!startDateStr || !endDateStr) continue;
            if (startDateStr > endDateStr) continue;

            var segInfo = {
                startDate: startDateStr,
                endDate: endDateStr,
                mode: mode,
                curveId: curveId
            };

            if (mode === 'fixed') {
                segInfo.value = parseFloat(seg.querySelector('.dnu-seg-value').value);
                if (isNaN(segInfo.value)) continue;
            } else if (mode === 'linear') {
                segInfo.startValue = parseFloat(seg.querySelector('.dnu-seg-start-value').value);
                segInfo.endValue = parseFloat(seg.querySelector('.dnu-seg-end-value').value);
                if (isNaN(segInfo.startValue) || isNaN(segInfo.endValue)) continue;
            }

            result.push(segInfo);
        }

        return result;
    }

    /**
     * 根据时间段信息生成该时间段的逐天 DNU 数据
     * @param {Object} segInfo - 时间段信息
     * @param {string} baseDate - 全局基准日期
     * @returns {Array<Object>} [{day: N, value: V}, ...]
     */
    function _generateSegmentDnuData(segInfo, baseDate) {
        var startDay = _daysBetweenExclusive(baseDate, segInfo.startDate) + 1;
        var endDay = _daysBetweenExclusive(baseDate, segInfo.endDate) + 1;
        var data = [];

        if (segInfo.mode === 'fixed') {
            for (var d = startDay; d <= endDay; d++) {
                data.push({ day: d, value: Math.round(segInfo.value) });
            }
        } else if (segInfo.mode === 'linear') {
            var totalDays = endDay - startDay;
            for (var d2 = startDay; d2 <= endDay; d2++) {
                var ratio = (totalDays === 0) ? 0 : (d2 - startDay) / totalDays;
                var val = segInfo.startValue + (segInfo.endValue - segInfo.startValue) * ratio;
                data.push({ day: d2, value: Math.round(val) });
            }
        }

        return data;
    }

    /**
     * 构建分段计算所需的 segments 数据结构
     * 将前端时间段信息转换为后端 calculate_dau_segmented 所需的格式
     *
     * @param {Array<Object>} segmentsInfo - 时间段信息数组（含 curveId）
     * @param {Array<Object>} defaultRetention - 标签页默认留存率数据
     * @param {number} tabIndex - 标签页索引
     * @returns {Array<Object>} 后端所需的 segments 数组
     */
    function _buildSegmentsForCalculation(segmentsInfo, defaultRetention, tabIndex) {
        // 获取全局基准日期
        var baseDate = _getBaseDateForTab(tabIndex);
        if (!baseDate) return [];

        // 同步构建 segments（曲线数据将在 calculate 中异步加载后填充）
        var segments = [];
        for (var j = 0; j < segmentsInfo.length; j++) {
            var segInfo = segmentsInfo[j];
            var dnuData = _generateSegmentDnuData(segInfo, baseDate);

            segments.push({
                dnu_data: dnuData,
                retention_data: null, // 稍后异步填充
                curveId: segInfo.curveId || ''
            });
        }

        return segments;
    }

    /**
     * 异步加载曲线数据并填充到 segments 中
     * @param {Array<Object>} segments - 分段数据数组
     * @param {Array<Object>} defaultRetention - 标签页默认留存率
     * @returns {Promise} 完成后 segments 中的 retention_data 已填充
     */
    function _loadCurveDataForSegments(segments, defaultRetention) {
        // 收集需要加载的曲线ID（去重）
        var curveIds = [];
        for (var i = 0; i < segments.length; i++) {
            if (segments[i].curveId && curveIds.indexOf(segments[i].curveId) === -1) {
                curveIds.push(segments[i].curveId);
            }
        }

        if (curveIds.length === 0) {
            // 没有专属曲线，全部使用默认留存率
            for (var k = 0; k < segments.length; k++) {
                segments[k].retention_data = defaultRetention;
            }
            return Promise.resolve();
        }

        // 并行加载所有需要的曲线数据
        var loadPromises = curveIds.map(function (curveId) {
            return utils.request('/api/retention-curves/' + curveId, { method: 'GET' })
                .then(function (result) {
                    return { id: curveId, data: result.curve.data };
                })
                .catch(function () {
                    return { id: curveId, data: null };
                });
        });

        return Promise.all(loadPromises).then(function (curveResults) {
            // 构建 curveId -> data 映射
            var curveMap = {};
            for (var m = 0; m < curveResults.length; m++) {
                if (curveResults[m].data) {
                    curveMap[curveResults[m].id] = curveResults[m].data;
                }
            }

            // 填充每个 segment 的 retention_data
            for (var n = 0; n < segments.length; n++) {
                if (segments[n].curveId && curveMap[segments[n].curveId]) {
                    segments[n].retention_data = curveMap[segments[n].curveId];
                } else {
                    segments[n].retention_data = defaultRetention;
                }
            }
        });
    }

    /**
     * 验证所有时间段是否都配置了有效的留存率曲线
     * @returns {Array<Element>} 无效的时间段 DOM 元素数组（空数组表示全部有效）
     */
    function _validateAllSegmentCurves() {
        var invalidSegments = [];
        var allSegments = document.querySelectorAll('.dnu-segment');

        for (var i = 0; i < allSegments.length; i++) {
            var seg = allSegments[i];
            var curveSelect = seg.querySelector('.dnu-seg-curve');
            if (!curveSelect) continue;

            // 检查是否选中了有效的曲线（非 disabled 且有值）
            var selectedOption = curveSelect.options[curveSelect.selectedIndex];
            if (!curveSelect.value || (selectedOption && selectedOption.disabled)) {
                invalidSegments.push(seg);
            }
        }

        return invalidSegments;
    }

    // ==================== DNU 时间段管理 ====================

    /**
     * 添加 DNU 时间段
     * @param {number} tabIndex - 标签页索引
     */
    function addDnuSegment(tabIndex) {
        var container = document.getElementById('dnuSegments_' + tabIndex);
        if (!container) return;

        // 自动推算起始日期：取已有时间段的最大结束日期 + 1 天
        var segments = container.querySelectorAll('.dnu-segment');
        var nextStartDate = _getTodayStr();
        for (var i = 0; i < segments.length; i++) {
            var endInput = segments[i].querySelector('.dnu-seg-end');
            if (endInput && endInput.value) {
                var candidateDate = _offsetDateStr(endInput.value, 1);
                if (candidateDate > nextStartDate) {
                    nextStartDate = candidateDate;
                }
            }
        }

        _addDnuSegmentDOM(tabIndex, container, {
            startDate: nextStartDate,
            endDate: _offsetDateStr(nextStartDate, 29),
            mode: 'fixed'
        });
    }

    /**
     * 删除 DNU 时间段
     * @param {Element} btn - 触发删除的按钮元素
     */
    function removeDnuSegment(btn) {
        var segment = btn.closest('.dnu-segment');
        if (segment && segment.parentNode) {
            var container = segment.parentNode;
            container.removeChild(segment);

            // 如果没有时间段了，提示用户
            if (container.querySelectorAll('.dnu-segment').length === 0) {
                utils.showToast('已清空所有时间段，请添加新的时间段', 'info');
            }
        }
    }

    /**
     * 清空所有 DNU 时间段
     * @param {number} tabIndex - 标签页索引
     */
    function clearDnuSegments(tabIndex) {
        if (!confirm('确定要清空所有 DNU 时间段吗？')) return;

        var container = document.getElementById('dnuSegments_' + tabIndex);
        if (!container) return;

        container.innerHTML = '';
        _dnuSegmentCounters[tabIndex] = 0;

        // 清除预览
        var preview = document.getElementById('dnuPreview_' + tabIndex);
        if (preview) preview.innerHTML = '';

        utils.showToast('已清空所有 DNU 时间段', 'info');
    }

    /**
     * DNU 数值模式切换回调
     * 切换日均固定值和线性变化模式时，显示/隐藏对应的输入字段
     *
     * @param {Element} selectEl - 模式选择下拉框元素
     */
    function onDnuModeChange(selectEl) {
        var segment = selectEl.closest('.dnu-segment');
        if (!segment) return;

        var mode = selectEl.value;
        var fixedFields = segment.querySelectorAll('.dnu-seg-fixed-fields');
        var linearFields = segment.querySelectorAll('.dnu-seg-linear-fields');

        for (var i = 0; i < fixedFields.length; i++) {
            fixedFields[i].style.display = (mode === 'fixed') ? '' : 'none';
        }
        for (var j = 0; j < linearFields.length; j++) {
            linearFields[j].style.display = (mode === 'linear') ? '' : 'none';
        }
    }

    /**
     * 从 DNU 时间段配置生成 "天数-数据" 对象数组
     * 将用户设置的时间段展开为逐天的 DNU 数据
     *
     * @param {number} tabIndex - 标签页索引
     * @returns {Array<Object>} 格式为 [{day: 1, value: 1500}, ...] 的对象数组
     */
    function _collectDnuFromSegments(tabIndex) {
        // 注意：baseDate 可通过 _getBaseDateForTab(tabIndex) 单独获取
        // 此函数仅返回数据数组，不改变原有接口
        var container = document.getElementById('dnuSegments_' + tabIndex);
        if (!container) return [];

        var segments = container.querySelectorAll('.dnu-segment');

        // 第一步：收集所有时间段的日期，确定全局基准日期（最早的起始日期 = day 1）
        var allDates = [];
        for (var p = 0; p < segments.length; p++) {
            var s = segments[p].querySelector('.dnu-seg-start').value;
            var e = segments[p].querySelector('.dnu-seg-end').value;
            if (s) allDates.push(s);
            if (e) allDates.push(e);
        }
        if (allDates.length === 0) return [];

        allDates.sort();
        var baseDate = allDates[0]; // 全局最早日期作为 day=1

        var dataMap = {}; // 用 Map 避免天数重复时的冲突，后面的时间段覆盖前面的

        for (var i = 0; i < segments.length; i++) {
            var seg = segments[i];
            var startDateStr = seg.querySelector('.dnu-seg-start').value;
            var endDateStr = seg.querySelector('.dnu-seg-end').value;
            var mode = seg.querySelector('.dnu-seg-mode').value;

            // 校验日期有效性
            if (!startDateStr || !endDateStr) continue;
            if (startDateStr > endDateStr) continue;

            // 将日期转换为相对于基准日期的天数序号
            var startDay = _daysBetweenExclusive(baseDate, startDateStr) + 1;
            var endDay = _daysBetweenExclusive(baseDate, endDateStr) + 1;

            if (mode === 'fixed') {
                var fixedValue = parseFloat(seg.querySelector('.dnu-seg-value').value);
                if (isNaN(fixedValue)) continue;

                for (var d = startDay; d <= endDay; d++) {
                    dataMap[d] = Math.round(fixedValue);
                }
            } else if (mode === 'linear') {
                var sv = parseFloat(seg.querySelector('.dnu-seg-start-value').value);
                var ev = parseFloat(seg.querySelector('.dnu-seg-end-value').value);
                if (isNaN(sv) || isNaN(ev)) continue;

                var totalDays = endDay - startDay;
                for (var d2 = startDay; d2 <= endDay; d2++) {
                    var ratio = (totalDays === 0) ? 0 : (d2 - startDay) / totalDays;
                    var val = sv + (ev - sv) * ratio;
                    dataMap[d2] = Math.round(val);
                }
            }
        }

        // 转换为数组并按天数排序
        var result = [];
        var days = Object.keys(dataMap).sort(function (a, b) { return parseInt(a) - parseInt(b); });
        for (var k = 0; k < days.length; k++) {
            result.push({ day: parseInt(days[k]), value: dataMap[days[k]] });
        }

        return result;
    }

    /**
     * 计算两个日期之间的天数差（不含首日）
     * @param {string} fromStr - 起始日期 YYYY-MM-DD
     * @param {string} toStr - 目标日期 YYYY-MM-DD
     * @returns {number} 天数差（fromStr 到 toStr 的天数，fromStr 当天为 0）
     */
    function _daysBetweenExclusive(fromStr, toStr) {
        var s = new Date(fromStr + 'T00:00:00');
        var e = new Date(toStr + 'T00:00:00');
        return Math.round((e - s) / MS_PER_DAY);
    }

    /**
     * 获取指定标签页 DNU 时间段的基准日期（最早的起始日期）
     * 用于将相对天数映射为实际日期，供图表横轴使用
     *
     * @param {number} tabIndex - 标签页索引
     * @returns {string|null} 基准日期 YYYY-MM-DD，无数据时返回 null
     */
    function _getBaseDateForTab(tabIndex) {
        var container = document.getElementById('dnuSegments_' + tabIndex);
        if (!container) return null;

        var segments = container.querySelectorAll('.dnu-segment');
        var allDates = [];

        for (var p = 0; p < segments.length; p++) {
            var s = segments[p].querySelector('.dnu-seg-start').value;
            if (s) allDates.push(s);
            var e = segments[p].querySelector('.dnu-seg-end').value;
            if (e) allDates.push(e);
        }

        if (allDates.length === 0) return null;
        allDates.sort();
        return allDates[0];
    }

    // ==================== 数据录入模式管理（仅留存率使用） ====================

    /**
     * 切换数据录入模式（手动输入 / Excel 导入）
     * 仅用于留存率数据
     *
     * @param {string} type - 数据类型：'retention'
     * @param {number} tabIndex - 标签页索引
     * @param {string} mode - 目标模式：'manual' 或 'import'
     */
    function switchInputMode(type, tabIndex, mode) {
        // 记录模式状态
        if (!_inputModes[type]) _inputModes[type] = {};
        _inputModes[type][tabIndex] = mode;

        // 获取模式切换按钮容器
        var prefix = (type === 'dnu') ? 'dnu' : 'ret';
        var manualPanel = document.getElementById(prefix + 'ManualPanel_' + tabIndex);
        var importPanel = document.getElementById(prefix + 'ImportPanel_' + tabIndex);

        // 获取切换按钮并更新高亮
        var toggleContainer = manualPanel ? manualPanel.closest('.data-section').querySelector('.input-mode-toggle') : null;
        if (toggleContainer) {
            var buttons = toggleContainer.querySelectorAll('.input-mode-btn');
            for (var i = 0; i < buttons.length; i++) {
                buttons[i].classList.remove('active');
                if (buttons[i].getAttribute('data-mode') === mode) {
                    buttons[i].classList.add('active');
                }
            }
        }

        // 切换面板显示
        if (manualPanel && importPanel) {
            if (mode === INPUT_MODE.MANUAL) {
                manualPanel.classList.add('active');
                importPanel.classList.remove('active');
            } else {
                manualPanel.classList.remove('active');
                importPanel.classList.add('active');
            }
        }
    }

    // ==================== 分析结果标签页管理 ====================

    /**
     * 切换分析结果区域的标签页
     * 控制分析结果标签栏高亮和下方图表面板的显隐
     *
     * @param {number|string} index - 目标标签页索引，或 'total' 表示全局汇总
     */
    function switchResultTab(index) {
        var resultTabsBar = document.getElementById('resultTabsBar');
        var resultPanelsContainer = document.getElementById('resultPanelsContainer');
        if (!resultTabsBar || !resultPanelsContainer) return;

        var tabs = resultTabsBar.querySelectorAll('.result-tab-item');
        var panels = resultPanelsContainer.querySelectorAll('.result-tab-panel');

        // 移除所有 active 状态
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].classList.remove('active');
        }
        for (var j = 0; j < panels.length; j++) {
            panels[j].classList.remove('active');
        }

        // 激活目标标签和面板
        var targetTab = resultTabsBar.querySelector('.result-tab-item[data-result-tab-index="' + index + '"]');
        var targetPanel = document.getElementById('chartSection_' + index);

        if (targetTab) targetTab.classList.add('active');
        if (targetPanel) targetPanel.classList.add('active');
    }

    // ==================== 标签页管理 ====================

    /**
     * 切换标签页
     * 通过 JS 控制标签栏高亮和下方面板的显隐，
     * 切换时销毁旧图表并重绘当前视图（由 chart 模块处理）
     *
     * @param {number} index - 目标标签页索引
     */
    function switchTab(index) {
        var tabs = utils.$$('.tab-item', utils.$('#tabsBar'));
        var panels = utils.$$('.tab-panel', utils.$('#tabPanelsContainer'));

        // 移除所有 active 状态
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].classList.remove('active');
        }
        for (var j = 0; j < panels.length; j++) {
            panels[j].classList.remove('active');
        }

        // 激活目标标签和面板
        if (tabs[index]) {
            tabs[index].classList.add('active');
        }
        if (panels[index]) {
            panels[index].classList.add('active');
        }

        state.activeTabIndex = index;
    }

    /**
     * 显示添加标签弹窗
     */
    function showAddTabModal() {
        var input = utils.$('#newTabNameInput');
        if (input) {
            input.value = '';
        }
        utils.showModal('#addTabModal');
        setTimeout(function () {
            if (input) input.focus();
        }, 100);
    }

    /**
     * 添加新标签页
     * 通过原生 JS 动态创建 DOM 元素，无需框架的虚拟 DOM 机制。
     * 这是传统前端开发中动态生成 UI 的标准方式。
     */
    function addTab() {
        var input = utils.$('#newTabNameInput');
        var tabName = (input ? input.value : '').trim();

        if (!tabName) {
            utils.showToast('请输入标签名称', 'error');
            return;
        }

        var newIndex = state.tabCount;

        // 1. 在标签栏中添加新标签（插入到 + 按钮之前）
        var tabsBar = utils.$('#tabsBar');
        var addBtn = utils.$('#addTabBtn');

        var tabDiv = document.createElement('div');
        tabDiv.className = 'tab-item';
        tabDiv.setAttribute('data-tab-index', newIndex);
        tabDiv.onclick = function () { switchTab(newIndex); };
        tabDiv.innerHTML = '<span class="tab-item__label">' + _escapeHtml(tabName) + '</span>' +
            '<button class="tab-item__close" title="删除标签" onclick="event.stopPropagation(); IAA.workspace.removeTab(' + newIndex + ')">✕</button>';

        tabsBar.insertBefore(tabDiv, addBtn);

        // 2. 创建对应的内容面板
        var panel = document.createElement('div');
        panel.className = 'tab-panel';
        panel.setAttribute('data-panel-index', newIndex);
        panel.innerHTML = _buildPanelHTML(tabName, newIndex);

        utils.$('#tabPanelsContainer').appendChild(panel);

        // 3. 在分析结果区域添加对应的标签和图表面板
        var resultTabsBar = document.getElementById('resultTabsBar');
        if (resultTabsBar) {
            var resultTabDiv = document.createElement('div');
            resultTabDiv.className = 'result-tab-item';
            resultTabDiv.setAttribute('data-result-tab-index', newIndex);
            resultTabDiv.onclick = function () { switchResultTab(newIndex); };
            resultTabDiv.innerHTML = '<span class="result-tab-item__label">' + _escapeHtml(tabName) + '</span>';

            resultTabsBar.appendChild(resultTabDiv);
        }

        // 在分析结果面板容器中添加对应的图表面板
        var resultPanelsContainer = document.getElementById('resultPanelsContainer');
        if (resultPanelsContainer) {
            var chartPanel = document.createElement('div');
            chartPanel.className = 'result-tab-panel';
            chartPanel.id = 'chartSection_' + newIndex;
            chartPanel.setAttribute('data-result-panel-index', newIndex);
            chartPanel.innerHTML =
                '<!-- 图表全局工具栏：日期范围 + 视角切换 -->' +
                '<div class="chart-global-toolbar" data-chart-group="tab_' + newIndex + '">' +
                '  <div class="chart-global-toolbar__left">' +
                '    <label class="chart-toolbar-label">📅 日期范围：</label>' +
                '    <input type="date" class="form-input chart-date-input" id="chartStartDate_' + newIndex + '" placeholder="起始日期">' +
                '    <span class="chart-toolbar-separator">至</span>' +
                '    <input type="date" class="form-input chart-date-input" id="chartEndDate_' + newIndex + '" placeholder="结束日期">' +
                '    <button class="btn btn-secondary btn-sm chart-toolbar-btn" onclick="IAA.workspace.applyChartDateRange(' + newIndex + ')">应用</button>' +
                '    <button class="btn btn-secondary btn-sm chart-toolbar-btn" onclick="IAA.workspace.resetChartDateRange(' + newIndex + ')">重置</button>' +
                '  </div>' +
                '  <div class="chart-global-toolbar__right">' +
                '    <div class="chart-view-toggle" id="chartViewToggle_' + newIndex + '">' +
                '      <button class="btn btn-chart-view active" data-view-mode="day"' +
                '              onclick="IAA.workspace.switchChartViewMode(' + newIndex + ', \'day\', this)">📅 日视角</button>' +
                '      <button class="btn btn-chart-view" data-view-mode="month"' +
                '              onclick="IAA.workspace.switchChartViewMode(' + newIndex + ', \'month\', this)">📆 月视角</button>' +
                '    </div>' +
                '  </div>' +
                '</div>' +
                '<!-- DNU 图表区域（独立一行） -->' +
                '<div class="chart-container chart-container--full">' +
                '  <div class="chart-container__toolbar">' +
                '    <div class="chart-container__header">📈 DNU 曲线</div>' +
                '    <div class="data-view-toggle" role="group" aria-label="DNU 数据展示切换">' +
                '      <button type="button" class="btn btn-data-view active" data-view="chart"' +
                '              onclick="IAA.chart.switchDataView(\'dnu\',' + newIndex + ',\'chart\',this)">📈 图表展示</button>' +
                '      <button type="button" class="btn btn-data-view" data-view="list"' +
                '              onclick="IAA.chart.switchDataView(\'dnu\',' + newIndex + ',\'list\',this)">📋 列表展示</button>' +
                '    </div>' +
                '  </div>' +
                '  <div id="dnuTableWrap_' + newIndex + '" class="data-table-wrap" style="display: none;"></div>' +
                '  <div id="chartCanvasDnu_' + newIndex + 'Wrap" class="data-chart-wrap">' +
                '    <canvas id="chartCanvasDnu_' + newIndex + '" height="300"></canvas>' +
                '  </div>' +
                '</div>' +
                '<!-- DAU 图表区域（独立一行） -->' +
                '<div class="chart-container chart-container--full">' +
                '  <div class="chart-container__toolbar">' +
                '    <div class="chart-container__header">📊 DAU 曲线</div>' +
                '    <div class="data-view-toggle" role="group" aria-label="DAU 数据展示切换">' +
                '      <button type="button" class="btn btn-data-view active" data-view="chart"' +
                '              onclick="IAA.chart.switchDataView(\'dau\',' + newIndex + ',\'chart\',this)">📈 图表展示</button>' +
                '      <button type="button" class="btn btn-data-view" data-view="list"' +
                '              onclick="IAA.chart.switchDataView(\'dau\',' + newIndex + ',\'list\',this)">📋 列表展示</button>' +
                '    </div>' +
                '  </div>' +
                '  <div id="dauTableWrap_' + newIndex + '" class="data-table-wrap" style="display: none;"></div>' +
                '  <div id="chartCanvasDau_' + newIndex + 'Wrap" class="data-chart-wrap">' +
                '    <canvas id="chartCanvasDau_' + newIndex + '" height="300"></canvas>' +
                '  </div>' +
                '</div>';

            resultPanelsContainer.appendChild(chartPanel);
        }

        state.tabCount++;

        // 3. 关闭弹窗并切换到新标签
        utils.hideModal('#addTabModal');
        switchTab(newIndex);
        utils.showToast('标签「' + tabName + '」已添加', 'success');

        // 4. 刷新新标签页的已保存曲线列表
        _refreshAllSavedCurvesLists();
    }

    /**
     * 删除标签页
     * @param {number} index - 要删除的标签索引
     */
    function removeTab(index) {
        var tab = utils.$('.tab-item[data-tab-index="' + index + '"]');
        var panel = utils.$('.tab-panel[data-panel-index="' + index + '"]');

        if (!tab || !panel) return;

        var tabName = tab.querySelector('.tab-item__label').textContent;
        if (!confirm('确定要删除标签「' + tabName + '」吗？')) return;

        // 销毁对应的 DNU 和 DAU 两个图表
        if (IAA.chart && IAA.chart.destroy) {
            IAA.chart.destroy('chartCanvasDnu_' + index);
            IAA.chart.destroy('chartCanvasDau_' + index);
        }

        // 删除分析结果区域中对应的标签和图表面板
        var resultTab = document.querySelector('.result-tab-item[data-result-tab-index="' + index + '"]');
        if (resultTab && resultTab.parentNode) {
            resultTab.parentNode.removeChild(resultTab);
        }
        var chartSection = document.getElementById('chartSection_' + index);
        if (chartSection && chartSection.parentNode) {
            chartSection.parentNode.removeChild(chartSection);
        }

        tab.parentNode.removeChild(tab);
        panel.parentNode.removeChild(panel);

        // 清理缓存数据
        _clearImportedData('retention', index);

        // 如果删除的是当前激活的标签，切换到第一个
        if (state.activeTabIndex === index) {
            var firstTab = utils.$('.tab-item');
            if (firstTab) {
                var firstIndex = parseInt(firstTab.getAttribute('data-tab-index'), 10);
                switchTab(firstIndex);
            }
        }

        utils.showToast('标签已删除', 'info');
    }

    // ==================== 数据收集 ====================

    /**
     * 从 DOM 中收集 "天数-数据" 对应格式的数据
     *
     * 收集策略：
     *   - DNU：从时间段配置实时生成逐天数据
     *   - 留存率：优先从缓存中获取完整数据，否则从 DOM 表格中读取
     *
     * @param {string} type - 数据类型：'dnu' 或 'retention'
     * @param {number} tabIndex - 标签页索引
     * @returns {Array<Object>} 格式为 [{"day": 1, "value": 1500}, ...] 的对象数组
     */
    function collectTableData(type, tabIndex) {
        // DNU 数据从时间段配置实时生成
        if (type === 'dnu') {
            return _collectDnuFromSegments(tabIndex);
        }

        // 留存率：优先从缓存中获取完整数据（导入/加载的数据可能超过预览行数）
        if (_importedData[type] && _importedData[type][tabIndex]) {
            return _importedData[type][tabIndex];
        }

        var tableId = 'retTable_' + tabIndex;
        var table = document.getElementById(tableId);
        if (!table) return [];

        var rows = table.querySelectorAll('tbody tr');
        var data = [];

        for (var i = 0; i < rows.length; i++) {
            var dayInput = rows[i].querySelector('.ret-day');
            var valueInput = rows[i].querySelector('.ret-value');

            if (dayInput && valueInput) {
                var day = parseInt(dayInput.value, 10);
                var value;

                // 留存率数据优先从 data-raw-value 属性读取原始小数值
                if (valueInput.hasAttribute('data-raw-value')) {
                    value = parseFloat(valueInput.getAttribute('data-raw-value'));
                } else {
                    value = parseFloat(valueInput.value);
                }

                // 只收集有效数据（天数和数值都不为空且有效）
                if (!isNaN(day) && !isNaN(value) && day > 0) {
                    data.push({ day: day, value: value });
                }
            }
        }

        return data;
    }

    /**
     * 收集当前激活标签页的完整数据
     * @returns {Object} 包含 tab_name, dnu_data, retention_data 的对象
     */
    function collectCurrentTabData() {
        var index = state.activeTabIndex;
        var tabEl = utils.$('.tab-item[data-tab-index="' + index + '"]');
        var tabName = tabEl ? tabEl.querySelector('.tab-item__label').textContent : '';

        return {
            tab_name: tabName,
            dnu_data: collectTableData('dnu', index),
            retention_data: collectTableData('retention', index)
        };
    }

    /**
     * 收集所有标签页的数据（用于保存和全局汇总）
     * @returns {Array<Object>} 所有标签页数据数组
     */
    function collectAllTabsData() {
        var tabs = utils.$$('.tab-item', utils.$('#tabsBar'));
        var allData = [];

        for (var i = 0; i < tabs.length; i++) {
            var index = parseInt(tabs[i].getAttribute('data-tab-index'), 10);
            var tabName = tabs[i].querySelector('.tab-item__label').textContent;

            allData.push({
                tab_name: tabName,
                dnu_data: collectTableData('dnu', index),
                retention_data: collectTableData('retention', index),
                dau_result: [] // 保存时 DAU 结果可能尚未计算
            });
        }

        return allData;
    }

    // ==================== 数据提交与计算 ====================

    /**
     * 点击"开始计算"按钮的处理函数
     *
     * 交互流程（传统前后端交互，无框架）：
     *   1. 遍历所有标签页，收集每个标签页的 DNU 和留存率数据
     *   2. 对每个有 DNU 数据的标签页，逐个请求后端计算 DAU
     *   3. 渲染每个标签页的 DNU 和 DAU 图表
     *   4. 所有标签页计算完成后，请求全局汇总并渲染汇总图表
     */
    function calculate() {
        var btn = utils.$('#calculateBtn');

        // 收集所有标签页的数据
        var tabs = utils.$$('.tab-item', utils.$('#tabsBar'));
        var allTabsData = [];

        for (var i = 0; i < tabs.length; i++) {
            var index = parseInt(tabs[i].getAttribute('data-tab-index'), 10);
            var tabName = tabs[i].querySelector('.tab-item__label').textContent;
            var dnuData = collectTableData('dnu', index);
            var retentionData = collectTableData('retention', index);

            // 收集时间段信息（含各自的留存率曲线ID）
            var segmentsInfo = _collectSegmentsInfo(index);

            var tabEntry = {
                tab_index: index,
                tab_name: tabName,
                dnu_data: dnuData,
                retention_data: retentionData,
                dau_result: []
            };

            // 始终使用分段模式（每个时间段都有专属曲线）
            if (segmentsInfo.length > 0) {
                tabEntry.segments = _buildSegmentsForCalculation(segmentsInfo, retentionData, index);
            }

            allTabsData.push(tabEntry);
        }

        // 过滤出有 DNU 数据的标签页
        var validTabs = allTabsData.filter(function (t) { return t.dnu_data.length > 0; });

        if (validTabs.length === 0) {
            utils.showToast('所有标签页均无 DNU 数据，请先输入数据', 'error');
            return;
        }

        // 验证所有时间段是否都配置了有效的留存率曲线
        var invalidSegments = _validateAllSegmentCurves();
        if (invalidSegments.length > 0) {
            utils.showToast('存在 ' + invalidSegments.length + ' 个时间段未配置有效的留存率曲线，请先在曲线库中保存曲线', 'error');
            // 高亮无效的时间段
            for (var vi = 0; vi < invalidSegments.length; vi++) {
                invalidSegments[vi].classList.add('dnu-segment--invalid');
            }
            return;
        }

        // 禁用按钮，显示加载状态
        btn.disabled = true;
        btn.textContent = '⏳ 计算中（0/' + validTabs.length + '）...';

        // 显示分析结果容器
        var resultSection = document.getElementById('resultSection');
        if (resultSection) {
            resultSection.style.display = 'block';
        }

        // 逐个计算每个标签页的 DAU（使用 Promise 链串行执行，避免并发过多）
        var completedCount = 0;
        var chain = Promise.resolve();

        validTabs.forEach(function (tabData) {
            chain = chain.then(function () {
                // 构建请求体：检查是否有时间段使用了专属留存率曲线
                var requestBody = {
                    tab_name: tabData.tab_name,
                    retention_data: tabData.retention_data
                };

                if (tabData.segments && tabData.segments.length > 0) {
                    // 分段模式：先异步加载各时间段的曲线数据，再发送计算请求
                    return _loadCurveDataForSegments(tabData.segments, tabData.retention_data)
                        .then(function () {
                            requestBody.segments = tabData.segments;
                            return utils.request('/api/calculate/dau', {
                                method: 'POST',
                                body: requestBody
                            });
                        });
                } else {
                    // 统一模式（向后兼容）
                    requestBody.dnu_data = tabData.dnu_data;
                    return utils.request('/api/calculate/dau', {
                        method: 'POST',
                        body: requestBody
                    });
                }
            })
                .then(function (result) {
                    // 保存 DAU 结果和 baseDate
                    tabData.dau_result = result.dau_result;
                    var baseDate = _getBaseDateForTab(tabData.tab_index);
                    tabData.baseDate = baseDate;

                    // 同步更新 allTabsData 中对应标签的 DAU 结果和 baseDate
                    for (var j = 0; j < allTabsData.length; j++) {
                        if (allTabsData[j].tab_index === tabData.tab_index) {
                            allTabsData[j].dau_result = result.dau_result;
                            allTabsData[j].baseDate = baseDate;
                            break;
                        }
                    }

                    // 渲染该标签页的图表（传递 baseDate 用于日期横轴）
                    var dnuCanvasId = 'chartCanvasDnu_' + tabData.tab_index;
                    var dauCanvasId = 'chartCanvasDau_' + tabData.tab_index;

                    if (IAA.chart && IAA.chart.renderDauChart) {
                        IAA.chart.renderDauChart(dnuCanvasId, dauCanvasId, tabData.dnu_data, result.dau_result, tabData.tab_name, baseDate);
                    }

                    // 初始化日期范围选择器的默认值
                    _initChartDateRange(tabData.tab_index, dnuCanvasId);

                    // 渲染列表视图数据
                    _renderResultListView('dnuTableWrap_' + tabData.tab_index, tabData.dnu_data, 'DNU');
                    _renderResultListView('dauTableWrap_' + tabData.tab_index, result.dau_result, 'DAU');

                    // 更新进度
                    completedCount++;
                    btn.textContent = '⏳ 计算中（' + completedCount + '/' + validTabs.length + '）...';
                });
        });

        // 所有标签页计算完成后，请求全局汇总
        chain
        .then(function () {
            // 切换到第一个有数据的标签页的分析结果面板
            if (validTabs.length > 0) {
                switchResultTab(validTabs[0].tab_index);
            }

            return _calculateTotal(allTabsData);
        })
        .then(function () {
            utils.showToast('计算完成！', 'success');
            // 计算完成后自动保存项目（静默模式，不弹出保存成功提示）
            saveProject(true);
        })
        .catch(function (err) {
            utils.showToast(err.message || '计算失败', 'error');
        })
        .finally(function () {
            btn.disabled = false;
            btn.textContent = '🚀 开始计算';
        });
    }

    /**
     * 计算全局汇总（内部函数）
     * 使用所有标签页已计算的 DAU 结果请求汇总
     *
     * @param {Array<Object>} allTabsData - 所有标签页数据（含已计算的 dau_result）
     */
    function _calculateTotal(allTabsData) {
        // 构建汇总请求数据
        var tabsForTotal = allTabsData.map(function (t) {
            return {
                tab_name: t.tab_name,
                dnu_data: t.dnu_data,
                dau_result: t.dau_result
            };
        });

        return utils.request('/api/calculate/total', {
            method: 'POST',
            body: { tabs: tabsForTotal }
        })
        .then(function (totalResult) {
            // 显示全局汇总独立容器并渲染图表
            var totalSection = document.getElementById('totalSection');
            if (totalSection) {
                totalSection.style.display = 'block';
            }

            // 获取全局最早的 baseDate（所有标签页中最早的日期）
            var globalBaseDate = null;
            if (allTabsData) {
                for (var gi = 0; gi < allTabsData.length; gi++) {
                    var bd = allTabsData[gi].baseDate;
                    if (bd && (!globalBaseDate || bd < globalBaseDate)) {
                        globalBaseDate = bd;
                    }
                }
            }

            if (IAA.chart && IAA.chart.renderTotalChart) {
                IAA.chart.renderTotalChart('totalChartCanvasDnu', 'totalChartCanvasDau', totalResult.total_dnu, totalResult.total_dau, globalBaseDate);
            }

            // 初始化汇总区域的日期范围选择器
            _initChartDateRange('total', 'totalChartCanvasDnu');

            // 渲染汇总区域的列表视图数据
            _renderResultListView('totalDnuTableWrap_total', totalResult.total_dnu, 'DNU 汇总');
            _renderResultListView('totalDauTableWrap_total', totalResult.total_dau, 'DAU 汇总');
        });
    }

    /**
     * 保存项目
     * 收集所有标签页数据，通过 fetch 异步提交到后端
     */
    function saveProject(silent) {
        var btn = utils.$('#saveProjectBtn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = '保存中...';
        }

        var payload = {
            project_id: state.projectId,
            project_name: state.projectName,
            tabs: collectAllTabsData()
        };

        utils.request('/api/project/save', {
            method: 'POST',
            body: payload
        })
        .then(function () {
            if (!silent) utils.showToast('项目保存成功', 'success');
        })
        .catch(function (err) {
            if (!silent) utils.showToast(err.message || '保存失败', 'error');
        })
        .finally(function () {
            if (btn) {
                btn.disabled = false;
                btn.textContent = '💾 保存项目';
            }
        });
    }

    // ==================== 表格行操作 ====================

    /**
     * 添加数据行（仅留存率使用）
     * @param {string} type - 'retention'
     * @param {number} tabIndex - 标签页索引
     */
    function addRow(type, tabIndex) {
        var tableId = 'retTable_' + tabIndex;
        var table = document.getElementById(tableId);
        if (!table) return;

        var tbody = table.querySelector('tbody');
        var rowCount = tbody.querySelectorAll('tr').length;
        var newDay = rowCount + 1;

        var tr = document.createElement('tr');
        tr.innerHTML = '<td><input type="number" class="ret-day" value="' + newDay + '" min="1"></td>' +
            '<td><input type="number" class="ret-value" value="" min="0" max="1" step="0.01" placeholder="如 0.45"></td>' +
            '<td><button class="btn btn-danger btn-sm" onclick="IAA.workspace.removeRow(this)">删除</button></td>';

        tbody.appendChild(tr);
    }

    /**
     * 删除数据行
     * @param {Element} btn - 触发删除的按钮元素
     */
    function removeRow(btn) {
        var tr = btn.closest('tr');
        if (tr && tr.parentNode) {
            tr.parentNode.removeChild(tr);
        }
    }

    /**
     * 清空表格数据（仅留存率使用）
     * @param {string} type - 'retention'
     * @param {number} tabIndex - 标签页索引
     */
    function clearTable(type, tabIndex) {
        if (!confirm('确定要清空所有数据吗？')) return;

        var tableId = 'retTable_' + tabIndex;
        var table = document.getElementById(tableId);
        if (!table) return;

        var tbody = table.querySelector('tbody');
        tbody.innerHTML = '';

        // 清除缓存数据
        _clearImportedData(type, tabIndex);

        // 重新添加5行空数据
        for (var i = 1; i <= 5; i++) {
            addRow(type, tabIndex);
        }
    }

    /**
     * 清除指定类型和标签页的导入数据缓存
     * @param {string} type - 数据类型
     * @param {number} tabIndex - 标签页索引
     */
    function _clearImportedData(type, tabIndex) {
        if (_importedData[type]) {
            delete _importedData[type][tabIndex];
        }
    }

    /**
     * 填充表格数据（供 Excel 解析模块调用，仅留存率使用）
     *
     * @param {string} type - 'retention'
     * @param {number} tabIndex - 标签页索引
     * @param {Array<Object>} data - [{"day": 1, "value": 0.45}, ...]
     */
    function fillTableData(type, tabIndex, data) {
        if (!data || !data.length) return;

        // 缓存完整数据，供 collectTableData 使用（保留原始精度）
        if (!_importedData[type]) _importedData[type] = {};
        _importedData[type][tabIndex] = data;

        // 渲染预览表格
        _renderImportPreview(type, tabIndex, data);

        // 自动切换到导入模式
        switchInputMode(type, tabIndex, INPUT_MODE.IMPORT);

        utils.showToast(
            '已导入 ' + data.length + ' 条数据' +
            (data.length > MAX_PREVIEW_ROWS ? '（展示前 ' + MAX_PREVIEW_ROWS + ' 行）' : ''),
            'success'
        );
    }

    /**
     * 渲染导入数据预览表格（仅留存率使用）
     * 注意：调用方需确保数据已缓存到 _importedData 中
     *
     * @param {string} type - 'retention'
     * @param {number} tabIndex - 标签页索引
     * @param {Array<Object>} data - 完整数据数组
     */
    function _renderImportPreview(type, tabIndex, data) {
        if (!data || !data.length) return;

        // 确保数据已缓存（兼容直接调用场景，如 _initSavedData）
        if (!_importedData[type]) _importedData[type] = {};
        if (!_importedData[type][tabIndex]) {
            _importedData[type][tabIndex] = data;
        }

        // 获取预览容器
        var prefix = 'ret';
        var previewWrapper = document.getElementById(prefix + 'ImportPreview_' + tabIndex);
        if (!previewWrapper) return;

        // 清空已有预览内容
        previewWrapper.innerHTML = '';

        // 仅展示前 MAX_PREVIEW_ROWS 行数据
        var displayCount = Math.min(data.length, MAX_PREVIEW_ROWS);

        // 数据行数标注
        var label = document.createElement('div');
        label.className = 'data-count-label';
        if (data.length > displayCount) {
            label.textContent = '📊 显示前 ' + displayCount + ' 行，共 ' + data.length + ' 行数据（完整数据已缓存，计算时使用全部数据）';
        } else {
            label.textContent = '📊 共 ' + data.length + ' 行数据';
        }
        previewWrapper.appendChild(label);

        // 构建滚动容器
        var scrollWrapper = document.createElement('div');
        scrollWrapper.className = 'data-table-wrapper data-table-wrapper--scrollable';

        // 构建纯文本展示表格（只读，无 input 输入框，无删除按钮）
        var previewTable = document.createElement('table');
        previewTable.className = 'data-table imported-data-table';

        // 表头
        var valueHeader = '留存率';
        previewTable.innerHTML = '<thead><tr>' +
            '<th>天数 (Day)</th>' +
            '<th>' + valueHeader + '</th>' +
            '</tr></thead>';

        var tbody = document.createElement('tbody');

        for (var i = 0; i < displayCount; i++) {
            var item = data[i];
            var tr = document.createElement('tr');

            // 留存率展示为百分比格式（保留两位小数）
            var displayValue = (item.value * 100).toFixed(2) + '%';
            tr.innerHTML = '<td>' + item.day + '</td>' +
                '<td>' + displayValue + '</td>';

            tbody.appendChild(tr);
        }

        previewTable.appendChild(tbody);
        scrollWrapper.appendChild(previewTable);
        previewWrapper.appendChild(scrollWrapper);

        // 添加"保存为留存率曲线"和"清除导入数据"按钮（同一行）
        var reuploadBar = document.createElement('div');
        reuploadBar.className = 'data-table__actions import-actions-bar';
        reuploadBar.style.marginTop = '12px';
        reuploadBar.innerHTML =
            '<button class="btn btn-primary btn-sm" onclick="IAA.workspace.showSaveCurveModal(' + tabIndex + ')">💾 保存为留存率曲线</button>' +
            '<button class="btn btn-secondary btn-sm" onclick="IAA.workspace.clearImportData(\'' + type + '\', ' + tabIndex + ')">' +
            '🗑️ 清除导入数据</button>';
        previewWrapper.appendChild(reuploadBar);
    }

    /**
     * 清除导入数据并切换回手动输入模式（仅留存率使用）
     * @param {string} type - 数据类型
     * @param {number} tabIndex - 标签页索引
     */
    function clearImportData(type, tabIndex) {
        // 清除缓存
        _clearImportedData(type, tabIndex);

        // 清空预览区域
        var prefix = 'ret';
        var previewWrapper = document.getElementById(prefix + 'ImportPreview_' + tabIndex);
        if (previewWrapper) {
            previewWrapper.innerHTML = '';
        }

        // 切换回手动输入模式
        switchInputMode(type, tabIndex, INPUT_MODE.MANUAL);

        utils.showToast('已清除导入数据，可重新手动输入或上传', 'info');
    }

    /**
     * 留存率百分比展示模式切换为编辑模式（保留用于手动输入场景）
     * 点击百分比展示的输入框时，切换为可编辑的小数输入模式
     * @param {Element} input - 输入框元素
     */
    function _switchToEditMode(input) {
        var rawValue = input.getAttribute('data-raw-value');
        if (rawValue !== null) {
            input.type = 'number';
            input.value = rawValue;
            input.removeAttribute('readonly');
            input.step = '0.01';
            input.min = '0';
            input.max = '1';
            input.classList.remove('ret-value-display');

            // 失焦时切换回百分比展示模式
            input.addEventListener('blur', function onBlur() {
                var newValue = parseFloat(input.value);
                if (!isNaN(newValue)) {
                    input.setAttribute('data-raw-value', newValue);
                    input.type = 'text';
                    input.value = (newValue * 100).toFixed(2) + '%';
                    input.setAttribute('readonly', 'readonly');
                    input.classList.add('ret-value-display');
                }
                input.removeEventListener('blur', onBlur);
            });
        }
    }

    // ==================== 留存率曲线保存与加载 ====================

    /**
     * 弹出保存曲线命名弹窗
     * @param {number} tabIndex - 标签页索引
     */
    function showSaveCurveModal(tabIndex) {
        // 检查是否有导入数据
        var data = collectTableData('retention', tabIndex);
        if (!data || data.length === 0) {
            utils.showToast('当前没有留存率数据可保存', 'error');
            return;
        }

        document.getElementById('saveCurveTabIndex').value = tabIndex;
        document.getElementById('curveNameInput').value = '';
        var hint = document.getElementById('curveNameHint');
        if (hint) hint.style.display = 'none';

        utils.showModal('#saveCurveModal');

        // 聚焦输入框
        setTimeout(function () {
            document.getElementById('curveNameInput').focus();
        }, 100);
    }

    /**
     * 确认保存曲线
     */
    function confirmSaveCurve() {
        var nameInput = document.getElementById('curveNameInput');
        var tabIndex = parseInt(document.getElementById('saveCurveTabIndex').value, 10);
        var name = nameInput.value.trim();
        var hint = document.getElementById('curveNameHint');

        if (!name) {
            if (hint) {
                hint.textContent = '⚠️ 请输入曲线名称';
                hint.className = 'form-hint form-hint--error';
                hint.style.display = 'block';
            }
            return;
        }

        var data = collectTableData('retention', tabIndex);
        if (!data || data.length === 0) {
            utils.showToast('当前没有留存率数据可保存', 'error');
            return;
        }

        var btn = document.getElementById('confirmSaveCurveBtn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = '保存中...';
        }

        utils.request('/api/retention-curves', {
            method: 'POST',
            body: { name: name, data: data }
        })
        .then(function (result) {
            utils.showToast(result.message || '曲线保存成功', 'success');
            utils.hideModal('#saveCurveModal');
            // 刷新所有标签页的已保存曲线列表
            _refreshAllSavedCurvesLists();
        })
        .catch(function (err) {
            if (hint) {
                hint.textContent = '⚠️ ' + (err.message || '保存失败');
                hint.className = 'form-hint form-hint--error';
                hint.style.display = 'block';
            }
        })
        .finally(function () {
            if (btn) {
                btn.disabled = false;
                btn.textContent = '确认保存';
            }
        });
    }

    /**
     * 刷新所有标签页的已保存曲线列表
     */
    function _refreshAllSavedCurvesLists() {
        utils.request('/api/retention-curves', { method: 'GET' })
        .then(function (result) {
            var curves = result.curves || [];
            // 缓存曲线列表供时间段选择器使用
            _cachedCurvesList = curves;
            // 更新所有标签页的曲线列表
            var lists = document.querySelectorAll('.saved-curves-list');
            for (var i = 0; i < lists.length; i++) {
                _renderSavedCurvesList(lists[i], curves);
            }
            // 同时刷新所有时间段的曲线选择器
            _refreshAllSegmentCurveSelects();
        })
        .catch(function () {
            // 静默失败
        });
    }

    /**
     * 渲染已保存曲线列表
     * @param {Element} container - 列表容器
     * @param {Array<Object>} curves - 曲线摘要数组
     */
    function _renderSavedCurvesList(container, curves) {
        if (!container) return;

        if (!curves || curves.length === 0) {
            container.innerHTML = '<div class="saved-curves-empty">暂无已保存的曲线</div>';
            return;
        }

        var html = '';
        for (var i = 0; i < curves.length; i++) {
            var c = curves[i];
            html += '<div class="saved-curve-item" data-curve-id="' + c.id + '">' +
                '  <div class="saved-curve-item__info" onclick="IAA.workspace.loadSavedCurve(\'' + c.id + '\')">' +
                '    <div class="saved-curve-item__name" title="' + _escapeHtml(c.name) + '">' + _escapeHtml(c.name) + '</div>' +
                '    <div class="saved-curve-item__meta">' + c.data_count + ' 天数据</div>' +
                '  </div>' +
                '  <button class="saved-curve-item__delete" title="删除" onclick="IAA.workspace.deleteSavedCurve(\'' + c.id + '\', \'' + _escapeHtml(c.name) + '\')">✕</button>' +
                '</div>';
        }
        container.innerHTML = html;
    }

    /**
     * 加载已保存的曲线数据到当前标签页
     * @param {string} curveId - 曲线ID
     */
    function loadSavedCurve(curveId) {
        var tabIndex = state.activeTabIndex;

        utils.request('/api/retention-curves/' + curveId, { method: 'GET' })
        .then(function (result) {
            var curve = result.curve;
            if (!curve || !curve.data || curve.data.length === 0) {
                utils.showToast('曲线数据为空', 'error');
                return;
            }

            // 使用与 Excel 导入相同的方式展示数据
            fillTableData('retention', tabIndex, curve.data);

            utils.showToast('已加载曲线「' + curve.name + '」', 'success');

            // 高亮选中的曲线项
            _highlightSelectedCurve(tabIndex, curveId);
        })
        .catch(function (err) {
            utils.showToast(err.message || '加载曲线失败', 'error');
        });
    }

    /**
     * 高亮选中的曲线项
     * @param {number} tabIndex - 标签页索引
     * @param {string} curveId - 曲线ID
     */
    function _highlightSelectedCurve(tabIndex, curveId) {
        var panel = document.getElementById('savedCurvesPanel_' + tabIndex);
        if (!panel) return;

        var items = panel.querySelectorAll('.saved-curve-item');
        for (var i = 0; i < items.length; i++) {
            items[i].classList.remove('saved-curve-item--active');
            if (items[i].getAttribute('data-curve-id') === curveId) {
                items[i].classList.add('saved-curve-item--active');
            }
        }
    }

    /**
     * 删除已保存的曲线
     * @param {string} curveId - 曲线ID
     * @param {string} curveName - 曲线名称
     */
    function deleteSavedCurve(curveId, curveName) {
        if (!confirm('确定要删除曲线「' + curveName + '」吗？')) return;

        utils.request('/api/retention-curves/' + curveId, { method: 'DELETE' })
        .then(function () {
            utils.showToast('曲线已删除', 'info');
            _refreshAllSavedCurvesLists();
        })
        .catch(function (err) {
            utils.showToast(err.message || '删除失败', 'error');
        });
    }

    // ==================== 结果列表视图渲染 ====================

    /**
     * 渲染分析结果的列表视图
     * 将数据以只读表格形式渲染到指定容器中，供用户在列表模式下查看
     * 支持两种调用方式：
     *   1. 原始数据模式（计算完成时）：传入 [{day, value}, ...] 格式
     *   2. 处理后数据模式（视角切换时）：传入 {labels, values} 格式
     *
     * @param {string} containerId - 列表容器的 DOM ID
     * @param {Array<Object>|Object} dataOrProcessed - 原始数据数组或处理后的数据对象
     * @param {string} label - 数据标签名称（如 'DNU'、'DAU'）
     * @param {string} [viewMode] - 可选，'day' 或 'month'，仅在处理后数据模式下使用
     */
    function _renderResultListView(containerId, dataOrProcessed, label, viewMode) {
        var container = document.getElementById(containerId);
        if (!container) return;

        var labels, values;

        // 判断是处理后的数据对象还是原始数据数组
        if (dataOrProcessed && dataOrProcessed.labels && dataOrProcessed.values) {
            // 处理后数据模式：直接使用 labels 和 values
            labels = dataOrProcessed.labels;
            values = dataOrProcessed.values;
        } else if (Array.isArray(dataOrProcessed) && dataOrProcessed.length > 0) {
            // 原始数据模式：按天数排序后提取
            var sorted = dataOrProcessed.slice().sort(function (a, b) { return a.day - b.day; });
            labels = sorted.map(function (item) { return String(item.day); });
            values = sorted.map(function (item) { return item.value; });
        } else {
            container.innerHTML = '<p style="text-align:center;color:#888;padding:20px;">暂无数据</p>';
            return;
        }

        if (!labels.length) {
            container.innerHTML = '<p style="text-align:center;color:#888;padding:20px;">暂无数据</p>';
            return;
        }

        // 根据视角模式决定第一列表头
        var isMonth = (viewMode === 'month');
        var firstColHeader = isMonth ? '月份' : '天数 (Day)';

        var html = '<table class="data-table imported-data-table">';
        html += '<thead><tr><th>' + _escapeHtml(firstColHeader) + '</th><th>' + _escapeHtml(label) + ' 数值</th></tr></thead>';
        html += '<tbody>';

        for (var i = 0; i < labels.length; i++) {
            var displayValue = (typeof values[i] === 'number')
                ? Math.round(values[i]).toLocaleString()
                : values[i];
            html += '<tr><td>' + labels[i] + '</td><td>' + displayValue + '</td></tr>';
        }

        html += '</tbody></table>';
        container.innerHTML = html;
    }

    /**
     * 同步更新指定图表组对应的列表视图
     * 从 chart_render.js 获取经过日期筛选和视角聚合处理后的数据，重新渲染列表
     *
     * @param {number|string} tabIndexOrTotal - 标签页索引或 'total'
     * @param {string} viewMode - 'day' 或 'month'
     * @param {string|null} startDate - 筛选起始日期
     * @param {string|null} endDate - 筛选结束日期
     */
    function _updateResultListViews(tabIndexOrTotal, viewMode, startDate, endDate) {
        if (!IAA.chart || !IAA.chart.getProcessedData) return;

        var canvasIds = _getCanvasIdsForGroup(tabIndexOrTotal);

        for (var i = 0; i < canvasIds.length; i++) {
            var canvasId = canvasIds[i];
            var processed = IAA.chart.getProcessedData(canvasId, viewMode, startDate, endDate);

            // 确定对应的列表容器 ID 和标签
            var tableWrapId, label;
            if (tabIndexOrTotal === 'total') {
                if (canvasId === 'totalChartCanvasDnu') {
                    tableWrapId = 'totalDnuTableWrap_total';
                    label = 'DNU 汇总';
                } else {
                    tableWrapId = 'totalDauTableWrap_total';
                    label = 'DAU 汇总';
                }
            } else {
                if (canvasId.indexOf('Dnu') !== -1) {
                    tableWrapId = 'dnuTableWrap_' + tabIndexOrTotal;
                    label = 'DNU';
                } else {
                    tableWrapId = 'dauTableWrap_' + tabIndexOrTotal;
                    label = 'DAU';
                }
            }

            if (processed) {
                _renderResultListView(tableWrapId, processed, label, viewMode);
            }
        }
    }

    // ==================== 图表工具栏交互函数 ====================

    /**
     * 初始化图表日期范围选择器的默认值
     * 计算完成后自动调用，根据图表数据设置日期输入框的 min/max/value
     *
     * @param {number|string} tabIndexOrTotal - 标签页索引或 'total'
     * @param {string} referenceCanvasId - 参考的 Canvas ID（用于获取日期范围）
     */
    function _initChartDateRange(tabIndexOrTotal, referenceCanvasId) {
        if (!IAA.chart || !IAA.chart.getChartDateRange) return;

        var range = IAA.chart.getChartDateRange(referenceCanvasId);
        if (!range) return;

        var startInput = document.getElementById('chartStartDate_' + tabIndexOrTotal);
        var endInput = document.getElementById('chartEndDate_' + tabIndexOrTotal);

        if (startInput) {
            startInput.min = range.minDate;
            startInput.max = range.maxDate;
            startInput.value = range.minDate;
        }
        if (endInput) {
            endInput.min = range.minDate;
            endInput.max = range.maxDate;
            endInput.value = range.maxDate;
        }
    }

    /**
     * 应用日期范围筛选
     * 由工具栏"应用"按钮触发，读取日期输入框的值并重新渲染图表
     *
     * @param {number|string} tabIndexOrTotal - 标签页索引或 'total'
     */
    function applyChartDateRange(tabIndexOrTotal) {
        var startInput = document.getElementById('chartStartDate_' + tabIndexOrTotal);
        var endInput = document.getElementById('chartEndDate_' + tabIndexOrTotal);

        var startDate = startInput ? startInput.value : null;
        var endDate = endInput ? endInput.value : null;

        // 获取当前视角模式
        var viewMode = _getCurrentViewMode(tabIndexOrTotal);

        // 确定需要更新的 Canvas ID
        var canvasIds = _getCanvasIdsForGroup(tabIndexOrTotal);

        if (IAA.chart && IAA.chart.applyChartFilterBatch) {
            IAA.chart.applyChartFilterBatch(canvasIds, viewMode, startDate, endDate);
        }

        // 同步更新列表视图
        _updateResultListViews(tabIndexOrTotal, viewMode, startDate, endDate);
    }

    /**
     * 重置日期范围筛选
     * 清空日期输入框并恢复显示全部数据
     *
     * @param {number|string} tabIndexOrTotal - 标签页索引或 'total'
     */
    function resetChartDateRange(tabIndexOrTotal) {
        var startInput = document.getElementById('chartStartDate_' + tabIndexOrTotal);
        var endInput = document.getElementById('chartEndDate_' + tabIndexOrTotal);

        // 重置为完整范围
        var canvasIds = _getCanvasIdsForGroup(tabIndexOrTotal);
        if (canvasIds.length > 0 && IAA.chart && IAA.chart.getChartDateRange) {
            var range = IAA.chart.getChartDateRange(canvasIds[0]);
            if (range) {
                if (startInput) startInput.value = range.minDate;
                if (endInput) endInput.value = range.maxDate;
            }
        }

        // 获取当前视角模式
        var viewMode = _getCurrentViewMode(tabIndexOrTotal);

        if (IAA.chart && IAA.chart.applyChartFilterBatch) {
            IAA.chart.applyChartFilterBatch(canvasIds, viewMode, null, null);
        }

        // 同步更新列表视图
        _updateResultListViews(tabIndexOrTotal, viewMode, null, null);
    }

    /**
     * 切换图表视角模式（日视角 / 月视角）
     * DNU 在月视角下采用求和，DAU 在月视角下采用平均值（由 chart_render.js 内部处理）
     *
     * @param {number|string} tabIndexOrTotal - 标签页索引或 'total'
     * @param {string} viewMode - 'day' 或 'month'
     * @param {HTMLElement} btn - 触发按钮
     */
    function switchChartViewMode(tabIndexOrTotal, viewMode, btn) {
        if (!btn) return;

        // 更新按钮激活状态
        var group = btn.closest('.chart-view-toggle');
        if (group) {
            group.querySelectorAll('.btn-chart-view').forEach(function (b) {
                b.classList.remove('active');
            });
            btn.classList.add('active');
        }

        // 读取当前日期范围
        var startInput = document.getElementById('chartStartDate_' + tabIndexOrTotal);
        var endInput = document.getElementById('chartEndDate_' + tabIndexOrTotal);
        var startDate = startInput ? startInput.value : null;
        var endDate = endInput ? endInput.value : null;

        // 确定需要更新的 Canvas ID
        var canvasIds = _getCanvasIdsForGroup(tabIndexOrTotal);

        if (IAA.chart && IAA.chart.applyChartFilterBatch) {
            IAA.chart.applyChartFilterBatch(canvasIds, viewMode, startDate, endDate);
        }

        // 同步更新列表视图
        _updateResultListViews(tabIndexOrTotal, viewMode, startDate, endDate);
    }

    /**
     * 获取指定图表组的所有 Canvas ID
     * @param {number|string} tabIndexOrTotal - 标签页索引或 'total'
     * @returns {Array<string>} Canvas ID 数组
     */
    function _getCanvasIdsForGroup(tabIndexOrTotal) {
        if (tabIndexOrTotal === 'total') {
            return ['totalChartCanvasDnu', 'totalChartCanvasDau'];
        }
        return [
            'chartCanvasDnu_' + tabIndexOrTotal,
            'chartCanvasDau_' + tabIndexOrTotal
        ];
    }

    /**
     * 获取指定图表组当前的视角模式
     * @param {number|string} tabIndexOrTotal - 标签页索引或 'total'
     * @returns {string} 'day' 或 'month'
     */
    function _getCurrentViewMode(tabIndexOrTotal) {
        var toggleContainer = document.getElementById('chartViewToggle_' + tabIndexOrTotal);
        if (!toggleContainer) return 'day';

        var activeBtn = toggleContainer.querySelector('.btn-chart-view.active');
        if (activeBtn) {
            return activeBtn.getAttribute('data-view-mode') || 'day';
        }
        return 'day';
    }

    // ==================== 辅助函数 ====================

    /**
     * HTML 转义，防止 XSS
     * 使用缓存的 DOM 元素避免重复创建
     * @param {string} str - 需要转义的字符串
     * @returns {string} 转义后的安全字符串
     */
    var _escapeDiv = document.createElement('div');
    function _escapeHtml(str) {
        _escapeDiv.textContent = str;
        return _escapeDiv.innerHTML;
    }

    /**
     * 动态构建新标签页面板的 HTML
     * DNU 使用时间段设置，留存率保留手动输入和 Excel 导入两种模式
     */
    function _buildPanelHTML(tabName, index) {
        return '' +
            '<div class="data-section">' +
'  <div class="data-section__title">📉 留存率数据</div>' +
            '  <div class="retention-layout">' +
            '    <div class="retention-layout__left">' +
            '      <div class="input-mode-toggle" data-type="retention" data-tab-index="' + index + '">' +
            '        <button class="input-mode-btn active" data-mode="manual" onclick="IAA.workspace.switchInputMode(\'retention\', ' + index + ', \'manual\')">✏️ 手动输入</button>' +
            '        <button class="input-mode-btn" data-mode="import" onclick="IAA.workspace.switchInputMode(\'retention\', ' + index + ', \'import\')">📁 Excel 导入</button>' +
            '      </div>' +
            '      <div class="input-mode-panel input-mode-panel--manual active" id="retManualPanel_' + index + '">' +
            '        <div class="data-table-wrapper">' +
            '          <table class="data-table" id="retTable_' + index + '">' +
            '            <thead><tr><th>天数 (Day)</th><th>留存率</th><th>操作</th></tr></thead>' +
            '            <tbody></tbody>' +
            '          </table>' +
            '        </div>' +
            '        <div class="data-table__actions">' +
            '          <button class="btn btn-secondary btn-sm" onclick="IAA.workspace.addRow(\'retention\', ' + index + ')">➕ 添加行</button>' +
            '          <button class="btn btn-secondary btn-sm" onclick="IAA.workspace.clearTable(\'retention\', ' + index + ')">🗑️ 清空</button>' +
            '        </div>' +
            '      </div>' +
            '      <div class="input-mode-panel input-mode-panel--import" id="retImportPanel_' + index + '">' +
            '        <div class="upload-area">' +
            '          <input type="file" accept=".xlsx,.xls,.csv" style="display:none" id="retFileInput_' + index + '" ' +
            '                 onchange="IAA.excel.handleUpload(this, \'retention\', ' + index + ')">' +
            '          <button class="btn btn-secondary btn-sm" onclick="document.getElementById(\'retFileInput_' + index + '\').click()">📁 选择文件上传</button>' +
            '          <span class="upload-area__text">留存率为小数形式（如 0.45 表示 45%）</span>' +
            '        </div>' +
            '        <div class="import-preview-wrapper" id="retImportPreview_' + index + '"></div>' +
            '      </div>' +
            '    </div>' +
            '    <div class="retention-layout__right">' +
            '      <div class="saved-curves-panel" id="savedCurvesPanel_' + index + '">' +
            '        <div class="saved-curves-panel__title">📋 已保存的曲线</div>' +
            '        <div class="saved-curves-list" id="savedCurvesList_' + index + '">' +
            '          <div class="saved-curves-empty">暂无已保存的曲线</div>' +
            '        </div>' +
            '      </div>' +
            '    </div>' +
            '  </div>' +
            '</div>' +
            '<div class="data-section">' +
'  <div class="data-section__title">📈 DNU 数据</div>' +
            '  <div class="dnu-segments-container" id="dnuSegments_' + index + '">' +
            '    <div class="dnu-segment" data-segment-index="0">' +
            '      <div class="dnu-segment__row">' +
            '        <div class="dnu-segment__field">' +
            '          <label>起始日期</label>' +
            '          <input type="date" class="form-input dnu-seg-start" value="' + _getTodayStr() + '">' +
            '        </div>' +
            '        <div class="dnu-segment__field">' +
            '          <label>结束日期</label>' +
            '          <input type="date" class="form-input dnu-seg-end" value="' + _offsetDateStr(_getTodayStr(), 29) + '">' +
            '        </div>' +
            '        <div class="dnu-segment__field">' +
            '          <label>数值模式</label>' +
            '          <select class="form-input dnu-seg-mode" onchange="IAA.workspace.onDnuModeChange(this)">' +
            '            <option value="fixed">日均固定值</option>' +
            '            <option value="linear">线性变化</option>' +
            '          </select>' +
            '        </div>' +
            '        <div class="dnu-segment__field dnu-seg-fixed-fields">' +
            '          <label>DNU 数值</label>' +
            '          <input type="number" class="form-input dnu-seg-value" value="" min="0" step="1" placeholder="如 1000">' +
            '        </div>' +
            '        <div class="dnu-segment__field dnu-seg-linear-fields" style="display:none;">' +
            '          <label>起始值</label>' +
            '          <input type="number" class="form-input dnu-seg-start-value" value="" min="0" step="1" placeholder="如 100">' +
            '        </div>' +
            '        <div class="dnu-segment__field dnu-seg-linear-fields" style="display:none;">' +
            '          <label>结束值</label>' +
            '          <input type="number" class="form-input dnu-seg-end-value" value="" min="0" step="1" placeholder="如 1000">' +
            '        </div>' +
            '        <div class="dnu-segment__field dnu-segment__field--curve">' +
            '          <label>📉 留存率曲线</label>' +
            '          <select class="form-input dnu-seg-curve" onchange="IAA.workspace.onSegmentCurveChange(this)">' +
            '            <option value="" disabled>无可用曲线</option>' +
            '          </select>' +
            '          <span class="dnu-seg-curve-hint dnu-seg-curve-hint--invalid">⚠️ 请先在左侧保存留存率曲线</span>' +
            '        </div>' +
            '        <div class="dnu-segment__actions">' +
'    <button class="btn btn-danger btn-sm" onclick="IAA.workspace.removeDnuSegment(this)" title="删除此时间段">删除</button>' +
            '        </div>' +
            '      </div>' +
            '    </div>' +
            '  </div>' +
            '  <div class="data-table__actions">' +
            '    <button class="btn btn-secondary btn-sm" onclick="IAA.workspace.addDnuSegment(' + index + ')">➕ 添加时间段</button>' +
            '    <button class="btn btn-secondary btn-sm" onclick="IAA.workspace.clearDnuSegments(' + index + ')">🗑️ 清空</button>' +
            '  </div>' +
            '  <div class="dnu-preview-wrapper" id="dnuPreview_' + index + '"></div>' +
            '</div>' +
            '</div>';
    }

    // ==================== 初始化 ====================

    // DOM 加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            init();
        });
    } else {
        init();
    }

    // ========== 公开 API ==========
    IAA.workspace = {
        switchTab: switchTab,
        switchResultTab: switchResultTab,
        showAddTabModal: showAddTabModal,
        addTab: addTab,
        removeTab: removeTab,
        calculate: calculate,
        saveProject: saveProject,
        addRow: addRow,
        removeRow: removeRow,
        clearTable: clearTable,
        fillTableData: fillTableData,
        collectTableData: collectTableData,
        collectCurrentTabData: collectCurrentTabData,
        collectAllTabsData: collectAllTabsData,
        switchInputMode: switchInputMode,
        clearImportData: clearImportData,
        _switchToEditMode: _switchToEditMode,
        addDnuSegment: addDnuSegment,
        removeDnuSegment: removeDnuSegment,
        clearDnuSegments: clearDnuSegments,
        onDnuModeChange: onDnuModeChange,
        showSaveCurveModal: showSaveCurveModal,
        confirmSaveCurve: confirmSaveCurve,
        loadSavedCurve: loadSavedCurve,
        deleteSavedCurve: deleteSavedCurve,
        applyChartDateRange: applyChartDateRange,
        resetChartDateRange: resetChartDateRange,
        switchChartViewMode: switchChartViewMode,
        onSegmentCurveChange: onSegmentCurveChange
    };

})(window);