/**
 * excel_parser.js - SheetJS (XLSX) Excel 解析封装模块
 * =====================================================
 * 挂载在 window.IAA.excel 命名空间下。
 * 基于 SheetJS 库解析用户上传的 Excel/CSV 文件，
 * 将数据转换为 "天数-数据" 对应的对象数组格式后填充到 DOM 表格中。
 *
 * 支持的文件格式：.xlsx / .xls / .csv
 *
 * Excel 文件格式约定：
 *   第一列为"天数"（Day），第二列为"数值"（Value）
 *   第一行为表头（自动跳过），从第二行开始读取数据
 *   示例：
 *     | Day | Value |
 *     |  1  | 1500  |
 *     |  2  | 1800  |
 */

;(function (global) {
    'use strict';

    var IAA = global.IAA;
    var utils = IAA.utils;

    /**
     * 处理文件上传事件
     * 前端使用 FileReader API 读取文件内容，再交给 SheetJS 解析
     * 这是不依赖后端的纯前端文件处理方案
     *
     * @param {HTMLInputElement} inputEl - 文件输入框元素
     * @param {string} type - 数据类型：'dnu' 或 'retention'
     * @param {number} tabIndex - 标签页索引
     */
    function handleUpload(inputEl, type, tabIndex) {
        var file = inputEl.files && inputEl.files[0];
        if (!file) return;

        // 校验文件类型
        var validTypes = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
            'application/vnd.ms-excel', // .xls
            'text/csv'                  // .csv
        ];
        var ext = file.name.split('.').pop().toLowerCase();

        if (validTypes.indexOf(file.type) === -1 && ['xlsx', 'xls', 'csv'].indexOf(ext) === -1) {
            utils.showToast('不支持的文件格式，请上传 .xlsx / .xls / .csv 文件', 'error');
            inputEl.value = '';
            return;
        }

        // 检查 SheetJS 是否已加载
        if (typeof XLSX === 'undefined') {
            utils.showToast('Excel 解析库未加载，请刷新页面重试', 'error');
            return;
        }

        var reader = new FileReader();

        reader.onload = function (e) {
            try {
                var data = new Uint8Array(e.target.result);
                var workbook = XLSX.read(data, { type: 'array' });

                // 读取第一个工作表
                var firstSheetName = workbook.SheetNames[0];
                var worksheet = workbook.Sheets[firstSheetName];

                // 转换为 JSON 数组（header: 1 表示以数组形式返回每行数据）
                var rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

                // 解析为 "天数-数据" 格式
                var parsed = _parseRawData(rawData, type);

                if (parsed.length === 0) {
                    utils.showToast('未能从文件中解析到有效数据，请检查格式', 'error');
                    return;
                }

                // 调用 workspace 模块的填充函数，将数据写入 DOM 表格
                if (IAA.workspace && IAA.workspace.fillTableData) {
                    IAA.workspace.fillTableData(type, tabIndex, parsed);
                }

            } catch (err) {
                utils.showToast('文件解析失败: ' + err.message, 'error');
            }
        };

        reader.onerror = function () {
            utils.showToast('文件读取失败', 'error');
        };

        // 以 ArrayBuffer 方式读取文件
        reader.readAsArrayBuffer(file);

        // 重置 input，允许重复上传同一文件
        inputEl.value = '';
    }

    /**
     * 解析 SheetJS 返回的原始二维数组为 "天数-数据" 对象数组
     *
     * 解析策略：
     *   1. 跳过第一行（表头）
     *   2. 每行取前两列：第一列为天数，第二列为数值
     *   3. 自动识别：如果第一列不是数字，尝试用行号作为天数
     *   4. 对于留存率数据，如果数值大于1则自动除以100（兼容百分比格式）
     *
     * @param {Array<Array>} rawData - SheetJS 解析的二维数组
     * @param {string} type - 'dnu' 或 'retention'
     * @returns {Array<Object>} [{day: 1, value: 1500}, ...]
     */
    function _parseRawData(rawData, type) {
        var result = [];

        if (!rawData || rawData.length < 2) {
            return result;
        }

        // 从第二行开始（跳过表头）
        for (var i = 1; i < rawData.length; i++) {
            var row = rawData[i];
            if (!row || row.length < 2) continue;

            var dayRaw = row[0];
            var valueRaw = row[1];

            // 解析天数
            var day = parseInt(dayRaw, 10);
            if (isNaN(day) || day <= 0) {
                // 如果第一列不是有效天数，用行号代替
                day = i;
            }

            // 解析数值
            var value = parseFloat(valueRaw);
            if (isNaN(value)) continue;

            // 留存率数据兼容处理：如果值大于1，认为是百分比形式，自动转换
            if (type === 'retention' && value > 1) {
                value = value / 100;
            }

            result.push({
                day: day,
                value: Math.round(value * 10000) / 10000 // 保留4位小数精度
            });
        }

        return result;
    }

    // ========== 公开 API ==========
    IAA.excel = {
        handleUpload: handleUpload
    };

})(window);
