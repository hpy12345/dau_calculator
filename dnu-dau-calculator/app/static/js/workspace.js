/**
 * workspace.js - 工作区 Tabs、表单交互与数据收发
 * =================================================
 * 挂载在 window.IAA.workspace 命名空间下。
 * 使用 ES5 IIFE 模块化模式，通过原生 JS + Fetch API 实现
 * 不依赖 Vue/React 等框架的传统前后端交互逻辑。
 *
 * 核心职责：
 *   1. 标签页 (Tabs) 的切换、新增、删除
 *   2. 数据录入模式管理（手动输入 / Excel 导入）
 *   3. 从 DOM 表格中收集 "天数-数据" 对应格式的数据
 *   4. 通过 fetch 异步提交 JSON 到后端 API
 *   5. 接收计算结果后调用 chart 模块渲染图表
 *   6. 统一数据展示行为：无论新导入还是加载已保存数据，均以预览模式展示
 */

;(function (global) {
    'use strict';

    var IAA = global.IAA;
    var utils = IAA.utils;

    // ========== 常量定义 ==========

    /** 预览模式下最大展示行数 */
    var MAX_PREVIEW_ROWS = 30;

    /** 数据录入模式枚举 */
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
     * 结构：{ 'dnu': { 0: [...], 1: [...] }, 'retention': { 0: [...], 1: [...] } }
     */
    var _importedData = {};

    /**
     * 各标签页各数据类型的当前录入模式
     * 结构：{ 'dnu': { 0: 'manual', 1: 'import' }, 'retention': { 0: 'import' } }
     */
    var _inputModes = {};

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
    }

    /**
     * 初始化已保存的项目数据
     * 从页面内嵌的 JSON 数据中读取，对有数据的标签页执行预览模式渲染，
     * 确保与 Excel 导入后的展示行为完全一致
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

            // 如果有 DNU 数据，以预览模式展示
            if (tab.dnu_data && tab.dnu_data.length > 0) {
                _renderImportPreview('dnu', i, tab.dnu_data);
                // 自动切换到导入模式
                switchInputMode('dnu', i, INPUT_MODE.IMPORT);
            }

            // 如果有留存率数据，以预览模式展示
            if (tab.retention_data && tab.retention_data.length > 0) {
                _renderImportPreview('retention', i, tab.retention_data);
                // 自动切换到导入模式
                switchInputMode('retention', i, INPUT_MODE.IMPORT);
            }
        }
    }

    // ==================== 数据录入模式管理 ====================

    /**
     * 切换数据录入模式（手动输入 / Excel 导入）
     *
     * 切换逻辑：
     *   1. 更新按钮高亮状态
     *   2. 显示/隐藏对应的面板
     *   3. 记录当前模式到内部状态
     *
     * @param {string} type - 数据类型：'dnu' 或 'retention'
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

    /**
     * 获取当前录入模式
     * @param {string} type - 数据类型
     * @param {number} tabIndex - 标签页索引
     * @returns {string} 当前模式
     */
    function _getInputMode(type, tabIndex) {
        if (_inputModes[type] && _inputModes[type][tabIndex]) {
            return _inputModes[type][tabIndex];
        }
        return INPUT_MODE.MANUAL;
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
                '<div class="charts-dual-layout">' +
'  <div class="chart-container">' +
                '    <div class="chart-container__toolbar">' +
                '      <div class="chart-container__header">📈 DNU 曲线</div>' +
                '      <div class="data-view-toggle" role="group" aria-label="DNU 数据展示切换">' +
                '        <button type="button" class="btn btn-data-view active" data-view="chart"' +
                '                onclick="IAA.chart.switchDataView(\'dnu\',' + newIndex + ',\'chart\',this)">📈 图表展示</button>' +
                '        <button type="button" class="btn btn-data-view" data-view="list"' +
                '                onclick="IAA.chart.switchDataView(\'dnu\',' + newIndex + ',\'list\',this)">📋 列表展示</button>' +
                '      </div>' +
                '    </div>' +
                '    <div id="dnuTableWrap_' + newIndex + '" class="data-table-wrap" style="display: none;"></div>' +
                '    <div id="chartCanvasDnu_' + newIndex + 'Wrap" class="data-chart-wrap">' +
                '      <canvas id="chartCanvasDnu_' + newIndex + '" height="300"></canvas>' +
                '    </div>' +
                '  </div>' +
'  <div class="chart-container">' +
                '    <div class="chart-container__toolbar">' +
                '      <div class="chart-container__header">📊 DAU 曲线</div>' +
                '      <div class="data-view-toggle" role="group" aria-label="DAU 数据展示切换">' +
                '        <button type="button" class="btn btn-data-view active" data-view="chart"' +
                '                onclick="IAA.chart.switchDataView(\'dau\',' + newIndex + ',\'chart\',this)">📈 图表展示</button>' +
                '        <button type="button" class="btn btn-data-view" data-view="list"' +
                '                onclick="IAA.chart.switchDataView(\'dau\',' + newIndex + ',\'list\',this)">📋 列表展示</button>' +
                '      </div>' +
                '    </div>' +
                '    <div id="dauTableWrap_' + newIndex + '" class="data-table-wrap" style="display: none;"></div>' +
                '    <div id="chartCanvasDau_' + newIndex + 'Wrap" class="data-chart-wrap">' +
                '      <canvas id="chartCanvasDau_' + newIndex + '" height="300"></canvas>' +
                '    </div>' +
                '  </div>' +
                '</div>';

            resultPanelsContainer.appendChild(chartPanel);
        }

        state.tabCount++;

        // 3. 关闭弹窗并切换到新标签
        utils.hideModal('#addTabModal');
        switchTab(newIndex);
        utils.showToast('标签「' + tabName + '」已添加', 'success');
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
        _clearImportedData('dnu', index);
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
     * 从 DOM 表格中收集 "天数-数据" 对应格式的数据
     *
     * 收集策略：
     *   1. 优先从缓存中获取完整数据（导入/加载的数据可能超过预览行数限制）
     *   2. 如果缓存中没有数据（用户手动输入），则从 DOM 表格中读取
     *   3. 留存率数据从 data-raw-value 属性读取原始小数值（而非百分比展示值）
     *
     * @param {string} type - 数据类型：'dnu' 或 'retention'
     * @param {number} tabIndex - 标签页索引
     * @returns {Array<Object>} 格式为 [{\"day\": 1, \"value\": 1500}, ...] 的对象数组
     */
    function collectTableData(type, tabIndex) {
        // 优先从缓存中获取完整数据（导入/加载的数据可能超过预览行数）
        if (_importedData[type] && _importedData[type][tabIndex]) {
            return _importedData[type][tabIndex];
        }

        var tableId = (type === 'dnu') ? 'dnuTable_' + tabIndex : 'retTable_' + tabIndex;
        var table = document.getElementById(tableId);
        if (!table) return [];

        var rows = table.querySelectorAll('tbody tr');
        var data = [];

        for (var i = 0; i < rows.length; i++) {
            var dayInput, valueInput;

            if (type === 'dnu') {
                dayInput = rows[i].querySelector('.dnu-day');
                valueInput = rows[i].querySelector('.dnu-value');
            } else {
                dayInput = rows[i].querySelector('.ret-day');
                valueInput = rows[i].querySelector('.ret-value');
            }

            if (dayInput && valueInput) {
                var day = parseInt(dayInput.value, 10);
                var value;

                // 留存率数据优先从 data-raw-value 属性读取原始小数值
                if (type === 'retention' && valueInput.hasAttribute('data-raw-value')) {
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

            allTabsData.push({
                tab_index: index,
                tab_name: tabName,
                dnu_data: dnuData,
                retention_data: retentionData,
                dau_result: []
            });
        }

        // 过滤出有 DNU 数据的标签页
        var validTabs = allTabsData.filter(function (t) { return t.dnu_data.length > 0; });

        if (validTabs.length === 0) {
            utils.showToast('所有标签页均无 DNU 数据，请先输入数据', 'error');
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
                return utils.request('/api/calculate/dau', {
                    method: 'POST',
                    body: {
                        tab_name: tabData.tab_name,
                        dnu_data: tabData.dnu_data,
                        retention_data: tabData.retention_data
                    }
                })
                .then(function (result) {
                    // 保存 DAU 结果
                    tabData.dau_result = result.dau_result;

                    // 同步更新 allTabsData 中对应标签的 DAU 结果
                    for (var j = 0; j < allTabsData.length; j++) {
                        if (allTabsData[j].tab_index === tabData.tab_index) {
                            allTabsData[j].dau_result = result.dau_result;
                            break;
                        }
                    }

                    // 渲染该标签页的图表
                    var dnuCanvasId = 'chartCanvasDnu_' + tabData.tab_index;
                    var dauCanvasId = 'chartCanvasDau_' + tabData.tab_index;

                    if (IAA.chart && IAA.chart.renderDauChart) {
                        IAA.chart.renderDauChart(dnuCanvasId, dauCanvasId, tabData.dnu_data, result.dau_result, tabData.tab_name);
                    }

                    // 渲染列表视图数据
                    _renderResultListView('dnuTableWrap_' + tabData.tab_index, tabData.dnu_data, 'DNU');
                    _renderResultListView('dauTableWrap_' + tabData.tab_index, result.dau_result, 'DAU');

                    // 更新进度
                    completedCount++;
                    btn.textContent = '⏳ 计算中（' + completedCount + '/' + validTabs.length + '）...';
                });
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

            if (IAA.chart && IAA.chart.renderTotalChart) {
                IAA.chart.renderTotalChart('totalChartCanvasDnu', 'totalChartCanvasDau', totalResult.total_dnu, totalResult.total_dau);
            }

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
     * 添加数据行
     * @param {string} type - 'dnu' 或 'retention'
     * @param {number} tabIndex - 标签页索引
     */
    function addRow(type, tabIndex) {
        var tableId = (type === 'dnu') ? 'dnuTable_' + tabIndex : 'retTable_' + tabIndex;
        var table = document.getElementById(tableId);
        if (!table) return;

        var tbody = table.querySelector('tbody');
        var rowCount = tbody.querySelectorAll('tr').length;
        var newDay = rowCount + 1;

        var tr = document.createElement('tr');
        if (type === 'dnu') {
            tr.innerHTML = '<td><input type="number" class="dnu-day" value="' + newDay + '" min="1"></td>' +
                '<td><input type="number" class="dnu-value" value="" min="0" step="1" placeholder="输入DNU"></td>' +
                '<td><button class="btn btn-danger btn-sm" onclick="IAA.workspace.removeRow(this)">删除</button></td>';
        } else {
            tr.innerHTML = '<td><input type="number" class="ret-day" value="' + newDay + '" min="1"></td>' +
                '<td><input type="number" class="ret-value" value="" min="0" max="1" step="0.01" placeholder="如 0.45"></td>' +
                '<td><button class="btn btn-danger btn-sm" onclick="IAA.workspace.removeRow(this)">删除</button></td>';
        }

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
     * 清空表格数据
     * @param {string} type - 'dnu' 或 'retention'
     * @param {number} tabIndex - 标签页索引
     */
    function clearTable(type, tabIndex) {
        if (!confirm('确定要清空所有数据吗？')) return;

        var tableId = (type === 'dnu') ? 'dnuTable_' + tabIndex : 'retTable_' + tabIndex;
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
     * 填充表格数据（供 Excel 解析模块调用）
     *
     * 统一展示策略（与加载已保存数据行为一致）：
     *   1. 完整数据存储在 _importedData 缓存中，供后续计算使用
     *   2. 调用 _renderImportPreview 渲染预览表格
     *   3. 自动切换到导入模式面板
     *
     * @param {string} type - 'dnu' 或 'retention'
     * @param {number} tabIndex - 标签页索引
     * @param {Array<Object>} data - [{\"day\": 1, \"value\": 1500}, ...]
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
     * 渲染导入数据预览表格（统一展示逻辑）
     *
     * 无论数据来源是 Excel 导入还是加载已保存项目，均使用此函数渲染，
     * 确保展示行为完全一致：
     *   1. 仅展示前 MAX_PREVIEW_ROWS 行数据，使用纯文本只读表格
     *   2. 表格容器带滚动条（固定最大高度），方便查看数据
     *   3. 在表格上方标注数据总行数和当前显示行数
     *   4. 留存率数据以百分比格式展示（保留两位小数），原始精度不受影响
     *
     * @param {string} type - 'dnu' 或 'retention'
     * @param {number} tabIndex - 标签页索引
     * @param {Array<Object>} data - 完整数据数组
     */
    function _renderImportPreview(type, tabIndex, data) {
        if (!data || !data.length) return;

        // 缓存完整数据
        if (!_importedData[type]) _importedData[type] = {};
        _importedData[type][tabIndex] = data;

        // 获取预览容器
        var prefix = (type === 'dnu') ? 'dnu' : 'ret';
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

        // 表头：仅两列（天数 + 数值），无操作列
        var valueHeader = (type === 'dnu') ? 'DNU 数值' : '留存率';
        previewTable.innerHTML = '<thead><tr>' +
            '<th>天数 (Day)</th>' +
            '<th>' + valueHeader + '</th>' +
            '</tr></thead>';

        var tbody = document.createElement('tbody');

        for (var i = 0; i < displayCount; i++) {
            var item = data[i];
            var tr = document.createElement('tr');

            if (type === 'dnu') {
                // DNU 数据直接展示数值
                tr.innerHTML = '<td>' + item.day + '</td>' +
                    '<td>' + item.value + '</td>';
            } else {
                // 留存率展示为百分比格式（保留两位小数）
                var displayValue = (item.value * 100).toFixed(2) + '%';
                tr.innerHTML = '<td>' + item.day + '</td>' +
                    '<td>' + displayValue + '</td>';
            }

            tbody.appendChild(tr);
        }

        previewTable.appendChild(tbody);
        scrollWrapper.appendChild(previewTable);
        previewWrapper.appendChild(scrollWrapper);

        // 添加"重新上传"按钮
        var reuploadBar = document.createElement('div');
        reuploadBar.className = 'data-table__actions';
        reuploadBar.style.marginTop = '12px';
        reuploadBar.innerHTML =
            '<button class="btn btn-secondary btn-sm" onclick="IAA.workspace.clearImportData(\'' + type + '\', ' + tabIndex + ')">' +
            '🗑️ 清除导入数据</button>';
        previewWrapper.appendChild(reuploadBar);
    }

    /**
     * 清除导入数据并切换回手动输入模式
     * @param {string} type - 数据类型
     * @param {number} tabIndex - 标签页索引
     */
    function clearImportData(type, tabIndex) {
        // 清除缓存
        _clearImportedData(type, tabIndex);

        // 清空预览区域
        var prefix = (type === 'dnu') ? 'dnu' : 'ret';
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

    // ==================== 结果列表视图渲染 ====================

    /**
     * 渲染分析结果的列表视图
     * 将数据以只读表格形式渲染到指定容器中，供用户在列表模式下查看
     *
     * @param {string} containerId - 列表容器的 DOM ID
     * @param {Array<Object>} data - 数据 [{day:1, value:1500}, ...]
     * @param {string} label - 数据标签名称（如 'DNU'、'DAU'）
     */
    function _renderResultListView(containerId, data, label) {
        var container = document.getElementById(containerId);
        if (!container) return;
        if (!data || !data.length) {
            container.innerHTML = '<p style="text-align:center;color:#888;padding:20px;">暂无数据</p>';
            return;
        }

        // 按天数排序
        var sorted = data.slice().sort(function (a, b) { return a.day - b.day; });

        var html = '<table class="data-table imported-data-table">';
        html += '<thead><tr><th>天数 (Day)</th><th>' + _escapeHtml(label) + ' 数值</th></tr></thead>';
        html += '<tbody>';

        for (var i = 0; i < sorted.length; i++) {
            var item = sorted[i];
            var displayValue;
            // DNU 数据始终以数值形式展示，不添加百分号
            displayValue = item.value.toLocaleString();
            html += '<tr><td>' + item.day + '</td><td>' + displayValue + '</td></tr>';
        }

        html += '</tbody></table>';
        container.innerHTML = html;
    }

    // ==================== 辅助函数 ====================

    /**
     * HTML 转义，防止 XSS
     */
    function _escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    /**
     * 动态构建新标签页面板的 HTML
     * 包含手动输入和 Excel 导入两种模式的完整面板结构
     */
    function _buildPanelHTML(tabName, index) {
        return '' +
            '<div class="data-section">' +
            '  <div class="data-section__title">📈 DNU（日新增用户）数据 <span class="badge">天数-数值 对应</span></div>' +
            '  <div class="input-mode-toggle" data-type="dnu" data-tab-index="' + index + '">' +
            '    <button class="input-mode-btn active" data-mode="manual" onclick="IAA.workspace.switchInputMode(\'dnu\', ' + index + ', \'manual\')">✏️ 手动输入</button>' +
            '    <button class="input-mode-btn" data-mode="import" onclick="IAA.workspace.switchInputMode(\'dnu\', ' + index + ', \'import\')">📁 Excel 导入</button>' +
            '  </div>' +
            '  <div class="input-mode-panel input-mode-panel--manual active" id="dnuManualPanel_' + index + '">' +
            '    <div class="data-table-wrapper">' +
            '      <table class="data-table" id="dnuTable_' + index + '">' +
            '        <thead><tr><th>天数 (Day)</th><th>DNU 数值</th><th>操作</th></tr></thead>' +
            '        <tbody></tbody>' +
            '      </table>' +
            '    </div>' +
            '    <div class="data-table__actions">' +
            '      <button class="btn btn-secondary btn-sm" onclick="IAA.workspace.addRow(\'dnu\', ' + index + ')">➕ 添加行</button>' +
            '      <button class="btn btn-secondary btn-sm" onclick="IAA.workspace.clearTable(\'dnu\', ' + index + ')">🗑️ 清空</button>' +
            '    </div>' +
            '  </div>' +
            '  <div class="input-mode-panel input-mode-panel--import" id="dnuImportPanel_' + index + '">' +
            '    <div class="upload-area">' +
            '      <input type="file" accept=".xlsx,.xls,.csv" style="display:none" id="dnuFileInput_' + index + '" ' +
            '             onchange="IAA.excel.handleUpload(this, \'dnu\', ' + index + ')">' +
            '      <button class="btn btn-secondary btn-sm" onclick="document.getElementById(\'dnuFileInput_' + index + '\').click()">📁 选择文件上传</button>' +
            '      <span class="upload-area__text">支持 .xlsx / .xls / .csv 格式</span>' +
            '    </div>' +
            '    <div class="import-preview-wrapper" id="dnuImportPreview_' + index + '"></div>' +
            '  </div>' +
            '</div>' +
            '<div class="data-section">' +
            '  <div class="data-section__title">📉 留存率数据 <span class="badge">天数-比率 对应</span></div>' +
            '  <div class="input-mode-toggle" data-type="retention" data-tab-index="' + index + '">' +
            '    <button class="input-mode-btn active" data-mode="manual" onclick="IAA.workspace.switchInputMode(\'retention\', ' + index + ', \'manual\')">✏️ 手动输入</button>' +
            '    <button class="input-mode-btn" data-mode="import" onclick="IAA.workspace.switchInputMode(\'retention\', ' + index + ', \'import\')">📁 Excel 导入</button>' +
            '  </div>' +
            '  <div class="input-mode-panel input-mode-panel--manual active" id="retManualPanel_' + index + '">' +
            '    <div class="data-table-wrapper">' +
            '      <table class="data-table" id="retTable_' + index + '">' +
            '        <thead><tr><th>天数 (Day)</th><th>留存率</th><th>操作</th></tr></thead>' +
            '        <tbody></tbody>' +
            '      </table>' +
            '    </div>' +
            '    <div class="data-table__actions">' +
            '      <button class="btn btn-secondary btn-sm" onclick="IAA.workspace.addRow(\'retention\', ' + index + ')">➕ 添加行</button>' +
            '      <button class="btn btn-secondary btn-sm" onclick="IAA.workspace.clearTable(\'retention\', ' + index + ')">🗑️ 清空</button>' +
            '    </div>' +
            '  </div>' +
            '  <div class="input-mode-panel input-mode-panel--import" id="retImportPanel_' + index + '">' +
            '    <div class="upload-area">' +
            '      <input type="file" accept=".xlsx,.xls,.csv" style="display:none" id="retFileInput_' + index + '" ' +
            '             onchange="IAA.excel.handleUpload(this, \'retention\', ' + index + ')">' +
            '      <button class="btn btn-secondary btn-sm" onclick="document.getElementById(\'retFileInput_' + index + '\').click()">📁 选择文件上传</button>' +
            '      <span class="upload-area__text">留存率为小数形式（如 0.45 表示 45%）</span>' +
            '    </div>' +
            '    <div class="import-preview-wrapper" id="retImportPreview_' + index + '"></div>' +
            '  </div>' +
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
        _switchToEditMode: _switchToEditMode
    };

})(window);