/**
 * workspace.js - 工作区 Tabs、表单交互与数据收发
 * =================================================
 * 挂载在 window.IAA.workspace 命名空间下。
 * 使用 ES5 IIFE 模块化模式，通过原生 JS + Fetch API 实现
 * 不依赖 Vue/React 等框架的传统前后端交互逻辑。
 *
 * 核心职责：
 *   1. 标签页 (Tabs) 的切换、新增、删除
 *   2. 从 DOM 表格中收集 "天数-数据" 对应格式的数据
 *   3. 通过 fetch 异步提交 JSON 到后端 API
 *   4. 接收计算结果后调用 chart 模块渲染图表
 */

;(function (global) {
    'use strict';

    var IAA = global.IAA;
    var utils = IAA.utils;

    // ========== 模块内部状态 ==========
    var state = {
        projectId: '',
        projectName: '',
        activeTabIndex: 0,
        tabCount: 0
    };

    /**
     * 初始化工作区
     * 页面加载完成后自动执行，从隐藏字段读取项目信息
     */
    function init() {
        state.projectId = (utils.$('#projectId') || {}).value || '';
        state.projectName = (utils.$('#projectName') || {}).value || '';
        state.tabCount = utils.$$('.tab-item', utils.$('#tabsBar')).length;
        state.activeTabIndex = 0;
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

        // 销毁对应图表
        if (IAA.chart && IAA.chart.destroy) {
            IAA.chart.destroy('chartCanvas_' + index);
        }

        tab.parentNode.removeChild(tab);
        panel.parentNode.removeChild(panel);

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
     * 这是不使用 Vue 等框架时的传统数据收集方式：
     * 直接遍历 DOM 中的 input 元素，读取用户输入值，
     * 组装成后端期望的 JSON 格式。
     *
     * @param {string} type - 数据类型：'dnu' 或 'retention'
     * @param {number} tabIndex - 标签页索引
     * @returns {Array<Object>} 格式为 [{"day": 1, "value": 1500}, ...] 的对象数组
     */
    function collectTableData(type, tabIndex) {
        var tableId = (type === 'dnu') ? 'dnuTable_' + tabIndex : 'retTable_' + tabIndex;
        var table = document.getElementById(tableId);
        if (!table) return [];

        var rows = table.querySelectorAll('tbody tr');
        var data = [];

        for (var i = 0; i < rows.length; i++) {
            var dayInput = rows[i].querySelector('.' + type.substring(0, 3) + '-day');
            var valueInput = rows[i].querySelector('.' + type.substring(0, 3) + '-value');

            // 对于 dnu 类型，class 是 dnu-day / dnu-value
            // 对于 retention 类型，class 是 ret-day / ret-value
            if (type === 'dnu') {
                dayInput = rows[i].querySelector('.dnu-day');
                valueInput = rows[i].querySelector('.dnu-value');
            } else {
                dayInput = rows[i].querySelector('.ret-day');
                valueInput = rows[i].querySelector('.ret-value');
            }

            if (dayInput && valueInput) {
                var day = parseInt(dayInput.value, 10);
                var value = parseFloat(valueInput.value);

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
     *   1. 从 DOM 收集当前 Tab 的数据
     *   2. 序列化为 JSON
     *   3. 通过 fetch POST 到后端 /api/calculate/dau
     *   4. 接收 JSON 响应
     *   5. 调用 Chart.js 渲染图表
     *   6. 再请求全局汇总数据并渲染汇总图表
     */
    function calculate() {
        var btn = utils.$('#calculateBtn');
        var currentData = collectCurrentTabData();

        if (!currentData.dnu_data.length) {
            utils.showToast('请先输入 DNU 数据', 'error');
            return;
        }

        // 禁用按钮，显示加载状态
        btn.disabled = true;
        btn.textContent = '⏳ 计算中...';

        // 步骤1：计算当前标签页的 DAU
        utils.request('/api/calculate/dau', {
            method: 'POST',
            body: currentData
        })
        .then(function (result) {
            // 步骤2：渲染当前标签页图表
            var chartSectionId = 'chartSection_' + state.activeTabIndex;
            var canvasId = 'chartCanvas_' + state.activeTabIndex;
            var section = document.getElementById(chartSectionId);

            if (section) {
                section.style.display = 'block';
            }

            // 调用 chart 模块渲染 DNU + DAU 对比曲线
            if (IAA.chart && IAA.chart.renderDauChart) {
                IAA.chart.renderDauChart(canvasId, currentData.dnu_data, result.dau_result, currentData.tab_name);
            }

            utils.showToast('计算完成！', 'success');

            // 步骤3：请求全局汇总
            return _calculateTotal(result.dau_result);
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
     * 将当前标签的 DAU 结果更新后，收集所有标签数据请求汇总
     */
    function _calculateTotal(currentDauResult) {
        var allTabs = collectAllTabsData();

        // 将当前标签的 DAU 结果填入
        for (var i = 0; i < allTabs.length; i++) {
            var tabEl = utils.$$('.tab-item', utils.$('#tabsBar'))[i];
            if (tabEl) {
                var idx = parseInt(tabEl.getAttribute('data-tab-index'), 10);
                if (idx === state.activeTabIndex) {
                    allTabs[i].dau_result = currentDauResult;
                }
            }
        }

        return utils.request('/api/calculate/total', {
            method: 'POST',
            body: { tabs: allTabs }
        })
        .then(function (totalResult) {
            // 渲染全局汇总图表
            var totalSection = document.getElementById('totalChartSection');
            if (totalSection) {
                totalSection.style.display = 'block';
            }

            if (IAA.chart && IAA.chart.renderTotalChart) {
                IAA.chart.renderTotalChart('totalChartCanvas', totalResult.total_dnu, totalResult.total_dau);
            }
        });
    }

    /**
     * 保存项目
     * 收集所有标签页数据，通过 fetch 异步提交到后端
     * 使用 navigator.sendBeacon 作为备选方案（页面关闭时）
     */
    function saveProject() {
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
            utils.showToast('项目保存成功', 'success');
        })
        .catch(function (err) {
            utils.showToast(err.message || '保存失败', 'error');
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

        // 重新添加5行空数据
        for (var i = 1; i <= 5; i++) {
            addRow(type, tabIndex);
        }
    }

    /**
     * 填充表格数据（供 Excel 解析模块调用）
     * @param {string} type - 'dnu' 或 'retention'
     * @param {number} tabIndex - 标签页索引
     * @param {Array<Object>} data - [{"day": 1, "value": 1500}, ...]
     */
    function fillTableData(type, tabIndex, data) {
        var tableId = (type === 'dnu') ? 'dnuTable_' + tabIndex : 'retTable_' + tabIndex;
        var table = document.getElementById(tableId);
        if (!table || !data || !data.length) return;

        var tbody = table.querySelector('tbody');
        tbody.innerHTML = '';

        for (var i = 0; i < data.length; i++) {
            var item = data[i];
            var tr = document.createElement('tr');

            if (type === 'dnu') {
                tr.innerHTML = '<td><input type="number" class="dnu-day" value="' + item.day + '" min="1"></td>' +
                    '<td><input type="number" class="dnu-value" value="' + item.value + '" min="0" step="1"></td>' +
                    '<td><button class="btn btn-danger btn-sm" onclick="IAA.workspace.removeRow(this)">删除</button></td>';
            } else {
                tr.innerHTML = '<td><input type="number" class="ret-day" value="' + item.day + '" min="1"></td>' +
                    '<td><input type="number" class="ret-value" value="' + item.value + '" min="0" max="1" step="0.01"></td>' +
                    '<td><button class="btn btn-danger btn-sm" onclick="IAA.workspace.removeRow(this)">删除</button></td>';
            }

            tbody.appendChild(tr);
        }

        utils.showToast('已导入 ' + data.length + ' 条数据', 'success');
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
     * 不使用框架模板引擎时，需要手动拼接 HTML 字符串
     */
    function _buildPanelHTML(tabName, index) {
        return '' +
            '<div class="data-section">' +
            '  <div class="data-section__title">📈 DNU（日新增用户）数据 <span class="badge">天数-数值 对应</span></div>' +
            '  <div class="upload-area">' +
            '    <input type="file" accept=".xlsx,.xls,.csv" style="display:none" id="dnuFileInput_' + index + '" ' +
            '           onchange="IAA.excel.handleUpload(this, \'dnu\', ' + index + ')">' +
            '    <button class="btn btn-secondary btn-sm" onclick="document.getElementById(\'dnuFileInput_' + index + '\').click()">📁 上传 Excel</button>' +
            '    <span class="upload-area__text">支持 .xlsx / .xls / .csv 格式</span>' +
            '  </div>' +
            '  <div class="data-table-wrapper">' +
            '    <table class="data-table" id="dnuTable_' + index + '">' +
            '      <thead><tr><th>天数 (Day)</th><th>DNU 数值</th><th>操作</th></tr></thead>' +
            '      <tbody></tbody>' +
            '    </table>' +
            '  </div>' +
            '  <div class="data-table__actions">' +
            '    <button class="btn btn-secondary btn-sm" onclick="IAA.workspace.addRow(\'dnu\', ' + index + ')">➕ 添加行</button>' +
            '    <button class="btn btn-secondary btn-sm" onclick="IAA.workspace.clearTable(\'dnu\', ' + index + ')">🗑️ 清空</button>' +
            '  </div>' +
            '</div>' +
            '<div class="data-section">' +
            '  <div class="data-section__title">📉 留存率数据 <span class="badge">天数-比率 对应</span></div>' +
            '  <div class="upload-area">' +
            '    <input type="file" accept=".xlsx,.xls,.csv" style="display:none" id="retFileInput_' + index + '" ' +
            '           onchange="IAA.excel.handleUpload(this, \'retention\', ' + index + ')">' +
            '    <button class="btn btn-secondary btn-sm" onclick="document.getElementById(\'retFileInput_' + index + '\').click()">📁 上传 Excel</button>' +
            '    <span class="upload-area__text">留存率为小数形式（如 0.45 表示 45%）</span>' +
            '  </div>' +
            '  <div class="data-table-wrapper">' +
            '    <table class="data-table" id="retTable_' + index + '">' +
            '      <thead><tr><th>天数 (Day)</th><th>留存率</th><th>操作</th></tr></thead>' +
            '      <tbody></tbody>' +
            '    </table>' +
            '  </div>' +
            '  <div class="data-table__actions">' +
            '    <button class="btn btn-secondary btn-sm" onclick="IAA.workspace.addRow(\'retention\', ' + index + ')">➕ 添加行</button>' +
            '    <button class="btn btn-secondary btn-sm" onclick="IAA.workspace.clearTable(\'retention\', ' + index + ')">🗑️ 清空</button>' +
            '  </div>' +
            '</div>' +
            '<div class="charts-section" id="chartSection_' + index + '" style="display:none;">' +
            '  <h3 class="charts-section__title">📊 ' + _escapeHtml(tabName) + ' - 分析结果</h3>' +
            '  <div class="chart-container">' +
            '    <div class="chart-container__header">DNU 与 DAU 对比曲线</div>' +
            '    <canvas id="chartCanvas_' + index + '" height="300"></canvas>' +
            '  </div>' +
            '</div>';
    }

    // ==================== 初始化 ====================

    // DOM 加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            init();
            // 为新标签页添加默认行
        });
    } else {
        init();
    }

    // ========== 公开 API ==========
    IAA.workspace = {
        switchTab: switchTab,
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
        collectAllTabsData: collectAllTabsData
    };

})(window);
