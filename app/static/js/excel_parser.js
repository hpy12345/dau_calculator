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
 *   支持有表头和无表头两种格式（自动智能检测）
 *   留存率数据支持小数（0.45）、百分比字符串（"45%"）、纯数字百分比（45.00）三种格式
 *   示例：
 *     | Day | Value |     或直接：  |  1  | 1500  |
 *     |  1  | 1500  |               |  2  | 1800  |
 *     |  2  | 1800  |
 */

;(function (global) {
    'use strict';

    var IAA = global.IAA;
    var utils = IAA.utils;

    // ========== 模块级常量 ==========

    /** 支持的 MIME 类型 */
    var VALID_MIME_TYPES = [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
        'application/vnd.ms-excel', // .xls
        'text/csv'                  // .csv
    ];

    /** 支持的文件扩展名 */
    var VALID_EXTENSIONS = ['xlsx', 'xls', 'csv'];

    /** 常见表头关键词集合（用于精确匹配和模糊匹配） */
    var HEADER_KEYWORDS = [
        'day', 'days', '天数', '天', '日期', 'date',
        'dnu', 'dau', 'value', '数值', '值', '新增', '用户',
        'retention', '留存', '留存率', 'rate', '比率', '百分比',
        'no', 'number', '序号', '编号', 'id', 'index'
    ];

    /** 精度保留倍数（保留4位小数） */
    var PRECISION_FACTOR = 10000;

    // ========== 辅助函数 ==========

    /**
     * 判断值是否为空（undefined / null / 空字符串）
     * @param {*} val - 待检测的值
     * @returns {boolean}
     */
    function _isEmpty(val) {
        return val === undefined || val === null || val === '';
    }

    /**
     * 从文件名中安全提取扩展名
     * @param {string} fileName - 文件名
     * @returns {string} 小写扩展名，无扩展名时返回空字符串
     */
    function _getFileExtension(fileName) {
        var dotIndex = fileName.lastIndexOf('.');
        if (dotIndex === -1 || dotIndex === fileName.length - 1) return '';
        return fileName.substring(dotIndex + 1).toLowerCase();
    }

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

        // 校验文件类型（优先检查扩展名，MIME 类型作为补充）
        var ext = _getFileExtension(file.name);

        if (VALID_EXTENSIONS.indexOf(ext) === -1 && VALID_MIME_TYPES.indexOf(file.type) === -1) {
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
     *   1. 智能检测第一行是否为表头（而非无条件跳过）
     *   2. 自动识别第一个包含数字数据的列作为起始读取位置
     *   3. 智能识别数据格式：
     *      - 百分比形式（如 "15%"）自动转换为小数形式（0.15）
     *      - 纯数字百分比（如 100.00、45.50，值>1）自动除以100归一化
     *      - 小数形式数据（0~1之间）保持原样
     *      - 所有数据统一转换为标准小数格式
     *   4. 自动识别：如果第一列不是数字，尝试用行号作为天数
     *
     * @param {Array<Array>} rawData - SheetJS 解析的二维数组
     * @param {string} type - 'dnu' 或 'retention'
     * @returns {Array<Object>} [{day: 1, value: 1500}, ...]
     */
    function _parseRawData(rawData, type) {
        var result = [];

        if (!rawData || rawData.length < 1) {
            return result;
        }

        // 自动识别第一个包含数字数据的列作为起始读取位置
        var dataStartCol = _findDataStartCol(rawData);
        if (dataStartCol < 0) {
            return result;
        }

        // 智能检测第一行是否为表头
        var startRow = _detectHeaderRow(rawData, dataStartCol);

        // 从检测到的数据起始行开始
        for (var i = startRow; i < rawData.length; i++) {
            var row = rawData[i];
            if (!row || row.length <= dataStartCol) continue;

            var dayRaw = row[dataStartCol];
            var valueRaw = row[dataStartCol + 1];

            // 如果只有一列数字数据，则用行号作为天数，该列作为数值
            if (dataStartCol + 1 >= row.length || valueRaw === undefined || valueRaw === null || valueRaw === '') {
                valueRaw = dayRaw;
                dayRaw = i;
            }

            // 解析天数
            var day = parseInt(dayRaw, 10);
            if (isNaN(day) || day <= 0) {
                // 如果第一列不是有效天数，用行号代替
                day = i;
            }

            // 智能解析数值（支持百分比和小数格式）
            var value = _parseNumericValue(valueRaw);
            if (isNaN(value)) continue;

            result.push({
                day: day,
                value: Math.round(value * PRECISION_FACTOR) / PRECISION_FACTOR // 保留4位小数精度
            });
        }

        // 对留存率数据进行自动归一化处理
        if (type === 'retention') {
            result = _normalizeRetentionData(result);
        }

        return result;
    }

    /**
     * 智能检测第一行是否为表头
     *
     * 检测策略：
     *   1. 如果第一行为空或只有一个单元格，视为表头（跳过）
     *   2. 检查第一行是否包含常见表头关键词（中英文），直接判定为表头
     *   3. 检查第一行数据列的单元格是否为纯数字
     *      - 如果数据列的值是有效数字 → 第一行是数据行，从第0行开始
     *      - 如果数据列的值不是数字（如 "Day"、"DNU"） → 第一行是表头，从第1行开始
     *
     * @param {Array<Array>} rawData - SheetJS 解析的二维数组
     * @param {number} dataStartCol - 数据起始列索引
     * @returns {number} 数据起始行索引（0 或 1）
     */
    function _detectHeaderRow(rawData, dataStartCol) {
        if (!rawData || rawData.length === 0) return 0;

        var firstRow = rawData[0];
        if (!firstRow || firstRow.length === 0) return 1; // 空行，跳过

        // 检查第一行所有单元格是否包含表头关键词
        for (var col = 0; col < firstRow.length; col++) {
            var cellValue = firstRow[col];
            if (_isEmpty(cellValue)) continue;

            var cellStr = String(cellValue).trim().toLowerCase();

            // 遍历关键词，同时支持精确匹配和模糊匹配
            for (var k = 0; k < HEADER_KEYWORDS.length; k++) {
                if (cellStr === HEADER_KEYWORDS[k] || cellStr.indexOf(HEADER_KEYWORDS[k]) !== -1) {
                    return 1; // 包含表头关键词，从第二行开始
                }
            }
        }

        // 检查数据列的第一行单元格是否为有效数字
        var dataColValue = firstRow[dataStartCol];
        var valueColValue = (dataStartCol + 1 < firstRow.length) ? firstRow[dataStartCol + 1] : undefined;

        var dataColIsNumeric = !_isEmpty(dataColValue) && !isNaN(_parseNumericValue(dataColValue));
        var valueColIsNumeric = !_isEmpty(valueColValue) && !isNaN(_parseNumericValue(valueColValue));

        // 两列都是数字 → 第一行是数据行
        if (dataColIsNumeric && valueColIsNumeric) {
            return 0;
        }

        // 只有一列是数字（可能只有一列数据）→ 也视为数据行
        if (dataColIsNumeric && _isEmpty(valueColValue)) {
            return 0;
        }

        // 默认跳过第一行（视为表头）
        return 1;
    }

    /**
     * 留存率数据自动归一化
     *
     * 智能识别留存率数据的格式并统一转换为 0~1 的小数形式：
     *   - 如果大部分数据值 > 1（如 100.00, 45.50），判定为百分比数值，自动除以 100
     *   - 如果大部分数据值在 0~1 之间（如 0.45, 1.00），保持原样
     *   - 带 % 后缀的数据已在 _parseNumericValue 中处理，此处不重复处理
     *
     * 判定阈值：如果超过 50% 的数据值 > 1，则认为整列是百分比数值
     *
     * @param {Array<Object>} data - [{day: 1, value: 100.00}, ...]
     * @returns {Array<Object>} 归一化后的数据
     */
    function _normalizeRetentionData(data) {
        if (!data || data.length === 0) return data;

        // 单次遍历：统计值 > 1 的数据条数
        var greaterThanOneCount = 0;
        var len = data.length;
        for (var i = 0; i < len; i++) {
            if (data[i].value > 1) {
                greaterThanOneCount++;
            }
        }

        // 如果超过 50% 的数据值 > 1，判定为百分比数值，需要除以 100
        if (greaterThanOneCount > len / 2) {
            for (var j = 0; j < len; j++) {
                data[j].value = Math.round((data[j].value / 100) * PRECISION_FACTOR) / PRECISION_FACTOR;
            }
        }

        return data;
    }

    /**
     * 自动识别第一个包含数字数据的列索引
     *
     * 扫描策略：
     *   从所有行（包括第一行）开始，逐列检查是否包含数字数据。
     *   如果某列中超过半数的行包含有效数字（含百分比格式），
     *   则认为该列是第一个数据列。
     *   注意：此函数不跳过表头行，因为表头检测由 _detectHeaderRow 负责。
     *
     * @param {Array<Array>} rawData - SheetJS 解析的二维数组
     * @returns {number} 第一个数字数据列的索引，未找到返回 -1
     */
    function _findDataStartCol(rawData) {
        if (!rawData || rawData.length < 1) return -1;

        var rowCount = rawData.length;

        // 获取最大列数
        var maxCols = 0;
        for (var r = 0; r < rowCount; r++) {
            if (rawData[r] && rawData[r].length > maxCols) {
                maxCols = rawData[r].length;
            }
        }

        // 逐列扫描，找到第一个包含数字数据的列
        for (var col = 0; col < maxCols; col++) {
            var numericCount = 0;
            var totalCount = 0;

            for (var row = 0; row < rowCount; row++) {
                if (!rawData[row] || col >= rawData[row].length) continue;

                var cellValue = rawData[row][col];
                if (_isEmpty(cellValue)) continue;

                totalCount++;

                // 检查是否为数字（包括百分比格式）
                if (!isNaN(_parseNumericValue(cellValue))) {
                    numericCount++;
                }
            }

            // 如果该列超过半数的有效行包含数字数据，认为是数据起始列
            if (totalCount > 0 && numericCount > totalCount / 2) {
                return col;
            }
        }

        return -1;
    }

    /**
     * 智能解析数值，支持多种格式
     *
     * 支持的格式：
     *   - 纯数字：1500, 0.45
     *   - 百分比字符串："15%", "45.5%" → 自动转换为小数 0.15, 0.455
     *   - 带空格的数字：" 1500 "
     *   - 已经是数字类型的值直接返回
     *
     * @param {*} raw - 原始单元格值
     * @returns {number} 解析后的数值，无法解析返回 NaN
     */
    function _parseNumericValue(raw) {
        // 空值处理
        if (_isEmpty(raw)) {
            return NaN;
        }

        // 如果已经是数字类型，直接返回
        if (typeof raw === 'number') {
            return raw;
        }

        // 转为字符串并去除首尾空格
        var str = String(raw).trim();

        // 百分比格式处理：如 "15%"、"45.5%" → 转换为小数
        if (str.charAt(str.length - 1) === '%') {
            var percentValue = parseFloat(str.slice(0, -1));
            if (!isNaN(percentValue)) {
                return percentValue / 100;
            }
            return NaN;
        }

        // 普通数字解析
        return parseFloat(str);
    }

    // ========== 公开 API ==========
    IAA.excel = {
        handleUpload: handleUpload
    };

})(window);