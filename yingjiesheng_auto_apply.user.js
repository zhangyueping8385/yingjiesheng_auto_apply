// ==UserScript==
// @name         应届生搜索页自动投递助手
// @namespace    https://tampermonkey.net/
// @version      0.1.9
// @description  适用于应届生搜索结果页、职位推荐页和实习页的自动投递脚本。手动登录和筛选后，可自动投递站内直投岗位，支持预检查、暂停继续、统计面板和位置记忆。
// @author       xiaozhang
// @match        https://q.yingjiesheng.com/jobs/search/*
// @match        https://www.yingjiesheng.com/jobs/search/*
// @match        https://q.yingjiesheng.com/pc/searchintention*
// @match        https://q.yingjiesheng.com/pc/searchintern*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=yingjiesheng.com
// @license      MIT
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/**
 * 应届生搜索页自动投递助手
 *
 * 脚本定位：
 * - 面向应届生搜索结果页、职位推荐页和实习页的自动化辅助脚本；
 * - 由用户手动完成登录、搜索和筛选后，再启动自动投递；
 * - 默认仅处理站内直投岗位，并静默跳过外链岗位。
 *
 * 当前能力：
 * - 自动识别当前页可投递岗位；
 * - 自动点击“立即申请”并处理常见确认弹窗；
 * - 支持发布时间过滤；
 * - 支持多关键词匹配模式切换；
 * - 支持开始前预检查、暂停继续、实时统计、自动翻页、日志展示和本地保存面板设置。
 *
 * 使用说明：
 * 1. 打开应届生职位搜索结果页、职位推荐页或实习页；
 * 2. 手动完成登录和筛选条件设置；
 * 3. 在右侧控制面板中确认过滤项；
 * 4. 点击“开始”执行自动投递；
 * 5. 如需中断，可点击“停止”。
 *
 * 注意事项：
 * - 本脚本依赖当前页面结构，站点改版后可能需要重新适配；
 * - 请优先使用小范围关键词进行测试；
 * - 如出现“今日投递过多”提示，脚本会自动停止。
 */

(function () {
    'use strict';

    // 每日投递超限时，页面会出现的提示文案。
    const DAILY_LIMIT_TEXT = '您今日投递太多，休息一下明天再来吧';
    // 仅把文本为“立即申请”的按钮视为候选申请按钮。
    const APPLY_TEXTS = ['立即申请'];
    // 用于判断投递成功的页面提示关键词。
    const SUCCESS_TEXTS = ['投递成功', '已投递'];
    // 页面中用于标识“站内直投”的标签文本。
    const INTERNAL_FLAG_TEXT = '站内直投';
    // 当前脚本支持自动投递的页面路径。
    const SUPPORTED_PAGE_PATTERNS = [
        '/jobs/search/',
        '/pc/searchintention',
        '/pc/searchintern'
    ];

    // 控制面板配置在本地存储中的键名，刷新页面后会自动恢复这些设置。
    const SETTINGS_STORAGE_KEY = 'yjs_auto_apply_settings_v1';
    // 控制面板拖动位置在本地存储中的键名。
    const PANEL_POSITION_STORAGE_KEY = 'yjs_auto_apply_panel_position_v1';

    // 关闭弹窗时沿用当前版本中的选择器，不主动回退或重置它们。
    const CLOSE_SELECTORS = [
        '.el-dialog__headerbtn',
        // '.el-dialog__close el-icon el-icon-close'
    ];

    // 翻页按钮的兜底选择器。
    const NEXT_PAGE_SELECTORS = [
        '.btn-next',
        '.el-pagination .btn-next',
        '.el-pager + button'
    ];

    // 日志区域最多保留的最近消息条数。
    const MAX_LOG_LINES = 50;
    // 每轮主循环和翻页间的基础等待时间。
    const LOOP_DELAY_MS = 1200;
    // 点击“立即申请”后等待页面弹出确认层的时间。
    const POST_APPLY_CLICK_WAIT_MS = 100;
    // 关闭成功弹窗后的收尾等待时间。
    const POST_DIALOG_CLOSE_WAIT_MS = 100;
    // 单个岗位从点击申请到等待成功反馈的最长时间。
    const APPLY_RESULT_TIMEOUT_MS = 3000;
    // 点击下一页后等待列表内容变化的最长时间。
    const PAGE_CHANGE_TIMEOUT_MS = 10000;

    // 面板默认选项配置。
    // onlyInternalDirect: 仅投站内直投，固定为 true，不再在界面中暴露开关。
    // silentSkipExternal: 外链岗位静默跳过，固定为 true，不再在界面中暴露开关。
    // filterOldJobs: 是否过滤发布时间超过阈值的岗位。
    // maxPublishDays: 发布时间过滤阈值，单位天。
    // filterIrrelevantJobs: 是否启用多关键词匹配。
    // keywordText: 关键词匹配使用的文本，支持输入多个关键字。
    // keywordMatchMode: 关键词匹配模式，any 表示命中任意一个，all 表示必须命中全部。
    const DEFAULT_SETTINGS = {
        onlyInternalDirect: true,
        silentSkipExternal: true,
        filterOldJobs: false,
        maxPublishDays: 30,
        filterIrrelevantJobs: false,
        keywordText: '',
        keywordMatchMode: 'any'
    };

    // 运行状态统一收口在一个对象里，便于后续维护与扩展。
    // running: 当前自动投递是否正在运行。
    // paused: 当前自动投递是否处于暂停状态。
    // loopPromise: 主循环对应的 Promise，便于串联开始/停止。
    // seenJobs: 当前轮次已经处理过的职位去重集合。
    // observer: 页面 DOM 观察器，用于监听超限提示。
    // panel/statusNode/logNode: 控制面板及其关键节点引用。
    // logLines: 当前显示在面板中的日志缓存，仅保留最新 MAX_LOG_LINES 条。
    // applyingNow: 是否正处于单岗位投递流程中。
    // openedNewWindow: 当前岗位是否触发了新标签页或外链跳转。
    // jobMetaCache: 职位详情页元信息缓存，避免重复抓取发布时间。
    // settings: 当前生效配置，会由默认值、本地存储和面板输入共同决定。
    // controls: 面板控件节点缓存，便于统一读写配置。
    // statNodes: 面板统计节点引用。
    // stats: 本轮实时统计信息。
    const state = {
        running: false,
        paused: false,
        loopPromise: null,
        seenJobs: new Set(),
        observer: null,
        panel: null,
        statusNode: null,
        logNode: null,
        pauseButton: null,
        logLines: [],
        applyingNow: false,
        openedNewWindow: false,
        jobMetaCache: new Map(),
        settings: { ...DEFAULT_SETTINGS },
        controls: {},
        statNodes: {},
        stats: {
            successCount: 0,
            failedCount: 0,
            skippedCount: 0,
            currentPage: 1
        }
    };

    // 从本地存储恢复上次保存的面板配置。
    function loadSettingsFromStorage() {
        try {
            const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
            if (!raw) {
                return { ...DEFAULT_SETTINGS };
            }
            const parsed = JSON.parse(raw);
            return {
                ...DEFAULT_SETTINGS,
                filterOldJobs: !!parsed.filterOldJobs,
                maxPublishDays: Math.max(1, Number(parsed.maxPublishDays) || DEFAULT_SETTINGS.maxPublishDays),
                filterIrrelevantJobs: !!parsed.filterIrrelevantJobs,
                keywordText: normalizeText(parsed.keywordText || ''),
                keywordMatchMode: parsed.keywordMatchMode === 'all' ? 'all' : DEFAULT_SETTINGS.keywordMatchMode,
                // 这两个能力仍然保留，但不再允许从界面或历史存储关闭。
                onlyInternalDirect: true,
                silentSkipExternal: true
            };
        } catch (error) {
            return { ...DEFAULT_SETTINGS };
        }
    }

    // 将当前面板配置保存到本地，刷新页面后继续沿用。
    function saveSettingsToStorage(settings) {
        try {
            window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
                filterOldJobs: !!settings.filterOldJobs,
                maxPublishDays: Math.max(1, Number(settings.maxPublishDays) || DEFAULT_SETTINGS.maxPublishDays),
                filterIrrelevantJobs: !!settings.filterIrrelevantJobs,
                keywordText: normalizeText(settings.keywordText || ''),
                keywordMatchMode: settings.keywordMatchMode === 'all' ? 'all' : DEFAULT_SETTINGS.keywordMatchMode
            }));
        } catch (error) {
            // 本地存储失败时不阻断主流程。
        }
    }

    // 保存控制面板拖动后的位置，刷新页面后继续沿用。
    function savePanelPosition(left, top) {
        try {
            window.localStorage.setItem(PANEL_POSITION_STORAGE_KEY, JSON.stringify({ left, top }));
        } catch (error) {
            // 本地存储失败时不阻断主流程。
        }
    }

    // 从本地存储恢复控制面板位置。
    function loadPanelPosition() {
        try {
            const raw = window.localStorage.getItem(PANEL_POSITION_STORAGE_KEY);
            if (!raw) {
                return null;
            }
            const parsed = JSON.parse(raw);
            if (typeof parsed.left !== 'number' || typeof parsed.top !== 'number') {
                return null;
            }
            return parsed;
        } catch (error) {
            return null;
        }
    }

    // 简单的异步延时工具，用于控制页面操作节奏。
    function sleep(ms) {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    // 统一清洗文本，减少空白符和换行对匹配造成的干扰。
    function normalizeText(text) {
        return (text || '').replace(/\s+/g, ' ').trim();
    }

    // 判断元素是否可见，避免点击隐藏节点。
    function isVisible(element) {
        if (!element || !(element instanceof HTMLElement)) {
            return false;
        }
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') {
            return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    // 判断元素是否处于禁用状态。
    function isDisabled(element) {
        return element.hasAttribute('disabled')
            || element.classList.contains('is-disabled')
            || element.classList.contains('disabled')
            || element.getAttribute('aria-disabled') === 'true';
    }

    // 判断文本中是否命中任一关键词。
    function containsAnyText(text, keywords) {
        return keywords.some((keyword) => text.includes(keyword));
    }

    // 获取当前页面可读文本，用于全局提示判断。
    function pageText() {
        return normalizeText(document.body ? document.body.innerText : '');
    }

    // 判断是否触发了每日投递上限。
    function hasDailyLimit() {
        return pageText().includes(DAILY_LIMIT_TEXT);
    }

    // 判断页面是否出现成功投递提示。
    function hasSuccessHint() {
        const text = pageText();
        return SUCCESS_TEXTS.some((item) => text.includes(item));
    }

    // 更新面板中的运行状态文案。
    function updateStatus(text, color) {
        if (!state.statusNode) {
            return;
        }
        state.statusNode.textContent = text;
        state.statusNode.style.color = color || '#1677ff';
    }

    // 统一写入日志，同时保证只保留最新 50 条。
    function log(message) {
        const time = new Date().toLocaleTimeString();
        const line = `[${time}] ${message}`;
        console.log('[YJS Auto Apply]', line);
        if (!state.logNode) {
            return;
        }
        state.logLines.unshift(line);
        state.logLines = state.logLines.slice(0, MAX_LOG_LINES);
        state.logNode.textContent = state.logLines.join('\n');
    }

    // 从页面或 URL 中推断当前页码，统计栏会优先显示真实页码。
    function detectCurrentPageNumber() {
        const activeNode = document.querySelector('.el-pager .active, .el-pagination .active, .el-pagination .is-active, .pagination .active');
        const activeText = normalizeText(activeNode ? activeNode.textContent : '');
        const activeNumber = Number(activeText);
        if (Number.isFinite(activeNumber) && activeNumber > 0) {
            return activeNumber;
        }

        try {
            const url = new URL(window.location.href);
            const pageText = url.searchParams.get('page') || url.searchParams.get('pageNo') || url.searchParams.get('p') || '';
            const pageNumber = Number(pageText);
            if (Number.isFinite(pageNumber) && pageNumber > 0) {
                return pageNumber;
            }
        } catch (error) {
            // URL 解析失败时保持静默，回退到默认页码。
        }

        return 1;
    }

    // 刷新面板顶部的实时统计。
    function updateStatsDisplay() {
        const mapping = [
            ['successCount', state.stats.successCount],
            ['failedCount', state.stats.failedCount],
            ['skippedCount', state.stats.skippedCount],
            ['currentPage', state.stats.currentPage]
        ];
        mapping.forEach(([key, value]) => {
            const node = state.statNodes[key];
            if (node) {
                node.textContent = String(value);
            }
        });
    }

    // 重置本轮统计，通常在用户点击开始或清空记录时调用。
    function resetRuntimeStats() {
        state.stats = {
            successCount: 0,
            failedCount: 0,
            skippedCount: 0,
            currentPage: detectCurrentPageNumber()
        };
        updateStatsDisplay();
    }

    // 设置当前页数统计。
    function setCurrentPageStat(pageNumber) {
        if (!Number.isFinite(pageNumber) || pageNumber <= 0) {
            return;
        }
        state.stats.currentPage = pageNumber;
        updateStatsDisplay();
    }

    // 累加某个统计项。
    function incrementStat(key, amount) {
        if (!Object.prototype.hasOwnProperty.call(state.stats, key)) {
            return;
        }
        state.stats[key] += typeof amount === 'number' ? amount : 1;
        updateStatsDisplay();
    }

    // 根据运行状态刷新“暂停/继续”按钮文案与可用状态。
    function updatePauseButton() {
        if (!state.pauseButton) {
            return;
        }
        if (!state.running) {
            state.pauseButton.textContent = '暂停';
            state.pauseButton.disabled = true;
            state.pauseButton.style.background = '#8c8c8c';
            state.pauseButton.style.cursor = 'not-allowed';
            return;
        }
        state.pauseButton.disabled = false;
        state.pauseButton.style.cursor = 'pointer';
        if (state.paused) {
            state.pauseButton.textContent = '继续';
            state.pauseButton.style.background = '#52c41a';
            return;
        }
        state.pauseButton.textContent = '暂停';
        state.pauseButton.style.background = '#faad14';
    }

    // 停止自动投递，并同步刷新面板状态。
    function stopAutoApply(reason) {
        if (!state.running) {
            updateStatus(reason || '已停止', '#fa8c16');
            if (reason) {
                log(reason);
            }
            return;
        }
        state.running = false;
        state.paused = false;
        updateStatus(reason || '已停止', '#ff4d4f');
        updatePauseButton();
        log(reason || '自动投递已停止');
    }

    // 将自动投递切换为暂停状态。
    function pauseAutoApply() {
        if (!state.running || state.paused) {
            return;
        }
        state.paused = true;
        updateStatus('状态：已暂停', '#faad14');
        updatePauseButton();
        log('已暂停，等待继续');
    }

    // 从暂停状态恢复自动投递。
    function resumeAutoApply() {
        if (!state.running || !state.paused) {
            return;
        }
        state.paused = false;
        updateStatus('状态：运行中', '#52c41a');
        updatePauseButton();
        log('已继续自动投递');
    }

    // 在各个异步步骤之间等待暂停结束，避免暂停期间继续点击页面。
    async function waitIfPaused() {
        while (state.running && state.paused) {
            await sleep(200);
        }
        return state.running;
    }

    // 判断当前页面是否属于脚本支持的岗位列表页。
    function ensureSearchPage() {
        const currentUrl = window.location.href;
        return SUPPORTED_PAGE_PATTERNS.some((pattern) => currentUrl.includes(pattern));
    }

    // 获取职位列表根节点，兼容搜索结果页、职位推荐页和实习页。
    function getListRoot() {
        return document.querySelector('#list, .search-list, .job-list, .list-content, .position-list');
    }

    // 获取当前岗位列表页里用户输入的关键词。
    function getSearchKeywordFromPage() {
        const url = new URL(window.location.href);
        const queryKeyword = normalizeText(
            url.searchParams.get('keyword')
            || url.searchParams.get('keywords')
            || url.searchParams.get('q')
            || ''
        );
        if (queryKeyword) {
            return queryKeyword;
        }

        const input = document.querySelector('#keywordInput, input[name="keyword"], input[type="search"], input[placeholder*="搜索"]');
        return normalizeText(input ? input.value : '');
    }

    // 根据面板控件同步脚本设置。
    function syncSettingsFromPanel() {
        if (!state.controls || !state.panel) {
            return state.settings;
        }

        const keywordInput = state.controls.keywordText;
        const keywordModeSelect = state.controls.keywordMatchMode;
        const fallbackKeyword = getSearchKeywordFromPage();

        state.settings = {
            // 这两个过滤能力固定开启，不再在界面中暴露开关。
            onlyInternalDirect: true,
            silentSkipExternal: true,
            filterOldJobs: !!(state.controls.filterOldJobs && state.controls.filterOldJobs.checked),
            maxPublishDays: Math.max(1, Number(state.controls.maxPublishDays ? state.controls.maxPublishDays.value : DEFAULT_SETTINGS.maxPublishDays) || DEFAULT_SETTINGS.maxPublishDays),
            filterIrrelevantJobs: !!(state.controls.filterIrrelevantJobs && state.controls.filterIrrelevantJobs.checked),
            keywordText: normalizeText(keywordInput ? keywordInput.value : '') || fallbackKeyword,
            keywordMatchMode: keywordModeSelect && keywordModeSelect.value === 'all' ? 'all' : DEFAULT_SETTINGS.keywordMatchMode
        };

        if (keywordInput && !normalizeText(keywordInput.value)) {
            keywordInput.placeholder = fallbackKeyword || '默认读取当前搜索关键词';
        }

        saveSettingsToStorage(state.settings);
        return state.settings;
    }

    // 获取职位卡片外层的详情链接节点。
    function getCardLink(card) {
        if (!card || !(card instanceof Element)) {
            return null;
        }
        if (card.matches('a.search-list-href')) {
            return card;
        }
        return card.closest('a.search-list-href') || card.querySelector('a.search-list-href');
    }

    // 获取职位详情链接地址。
    function getCardHref(card) {
        const link = getCardLink(card);
        return normalizeText(link ? (link.getAttribute('href') || link.href || '') : '');
    }

    // 判断链接是否是站内职位详情页。
    function isInternalJobHref(href) {
        return href.includes('/jobdetail/');
    }

    // 判断链接是否明显指向第三方投递平台。
    function isExternalJobHref(href) {
        return href.includes('/thirdlink')
            || href.includes('campus.51job.com')
            || href.includes('xyz.51job.com')
            || href.includes('app.mokahr.com')
            || href.includes('zhiye.com')
            || href.includes('zhaopin.com');
    }

    // 优先定位职位主列表的第一层包裹节点。
    function getPrimaryJobWrapper() {
        const selectors = [
            '#list > div:first-child',
            '.search-list > div:first-child',
            '.job-list > div:first-child',
            '.list-content > div:first-child',
            '.position-list > div:first-child'
        ];
        return selectors.map((selector) => document.querySelector(selector)).find(Boolean) || null;
    }

    // 收集当前页所有可见职位卡片。
    function getJobCards() {
        const primaryWrapper = getPrimaryJobWrapper();
        if (primaryWrapper) {
            const directCards = Array.from(primaryWrapper.children).filter((element) => {
                return element instanceof HTMLElement
                    && isVisible(element)
                    && normalizeText(element.innerText || '').length > 20;
            });
            if (directCards.length > 0) {
                return directCards;
            }
        }

        const listRoot = getListRoot();
        if (!listRoot) {
            return [];
        }

        const selector = '[class*="job"], [class*="item"], [class*="card"], li';
        return Array.from(listRoot.querySelectorAll(selector)).filter((element) => {
            return element instanceof HTMLElement
                && isVisible(element)
                && normalizeText(element.innerText || '').length > 20;
        });
    }

    // 从任意子节点反向定位所属职位卡片容器。
    function getJobContainer(element) {
        const primaryWrapper = getPrimaryJobWrapper();
        if (primaryWrapper) {
            let current = element;
            while (current && current.parentElement) {
                if (current.parentElement === primaryWrapper) {
                    return current;
                }
                current = current.parentElement;
            }
        }

        return element.closest('[class*="job"], [class*="item"], [class*="card"], li') || element.parentElement || element;
    }

    // 统一点击函数，支持在必要时禁用自动滚动。
    function safeClick(element, options) {
        if (!element) {
            return false;
        }

        const shouldScroll = !options || options.scroll !== false;
        if (shouldScroll) {
            element.scrollIntoView({ block: 'center', behavior: 'auto' });
        }

        try {
            element.click();
            return true;
        } catch (error) {
            try {
                ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((eventName) => {
                    element.dispatchEvent(new MouseEvent(eventName, {
                        bubbles: true,
                        cancelable: true,
                        view: window
                    }));
                });
                return true;
            } catch (dispatchError) {
                log(`点击失败: ${dispatchError.message || dispatchError}`);
                return false;
            }
        }
    }

    // 关闭当前可见弹窗，但不输出额外日志。
    function closeVisibleDialogs() {
        const uniqueButtons = new Map();

        CLOSE_SELECTORS.forEach((selector) => {
            document.querySelectorAll(selector).forEach((element) => {
                if (!isVisible(element) || isDisabled(element)) {
                    return;
                }
                const button = element.closest('button') || element;
                const dialog = button.closest('.el-dialog, .el-message-box') || button;
                if (!uniqueButtons.has(dialog)) {
                    uniqueButtons.set(dialog, button);
                }
            });
        });

        uniqueButtons.forEach((button) => {
            safeClick(button, { scroll: false });
        });
    }

    // 生成职位去重键，避免同一职位反复投递。
    function buildJobKey(element) {
        const container = getJobContainer(element);
        const text = normalizeText(container.innerText || element.innerText || '');
        return text.slice(0, 120);
    }

    // 提取职位标题，日志与关键词过滤都会使用它。
    function extractJobTitle(element) {
        const container = getJobContainer(element);
        const titleNode = container.querySelector('a, [class*="title"], .title');
        const titleText = normalizeText(titleNode ? titleNode.innerText : '');
        if (titleText) {
            return titleText.split(' ')[0].slice(0, 50);
        }
        const lines = normalizeText(container.innerText || '').split('\n').map((item) => item.trim()).filter(Boolean);
        return (lines[0] || '').slice(0, 50);
    }

    // 判断某个职位元素所在卡片是否属于站内直投。
    function isInternalDirectCard(card) {
        const text = normalizeText(card.innerText || '');
        const href = getCardHref(card);
        return text.includes(INTERNAL_FLAG_TEXT)
            || (isInternalJobHref(href) && !isExternalJobHref(href));
    }

    // 判断职位卡片是否已变成已投递状态。
    function hasAppliedState(element) {
        const container = getJobContainer(element);
        const text = normalizeText(container.innerText || element.innerText || '');
        return text.includes('已投递');
    }

    // 判断当前节点是否可作为“立即申请”点击目标。
    function isApplyButtonElement(element) {
        if (!element || !isVisible(element) || isDisabled(element)) {
            return false;
        }
        const text = normalizeText(element.innerText);
        const className = typeof element.className === 'string' ? element.className : '';
        if (text.includes('已投递')) {
            return false;
        }
        if (className.includes('right-btn')) {
            return true;
        }
        return text === '立即申请';
    }

    // 在职位卡片中优先定位真正可点击的“立即申请”节点。
    function resolveApplyClickTarget(card) {
        const rightBtn = card.querySelector('.right-btn');
        if (rightBtn && isVisible(rightBtn)) {
            const exactChild = Array.from(rightBtn.children).find((element) => {
                return element instanceof HTMLElement
                    && isVisible(element)
                    && !element.classList.contains('el-dialog__wrapper')
                    && normalizeText(element.innerText) === '立即申请';
            });
            if (exactChild) {
                return exactChild;
            }

            const exactDescendant = Array.from(rightBtn.querySelectorAll('button, a, div, span')).find((element) => {
                return isVisible(element)
                    && !isDisabled(element)
                    && normalizeText(element.innerText) === '立即申请';
            });
            if (exactDescendant) {
                return exactDescendant;
            }

            return rightBtn;
        }

        return Array.from(card.querySelectorAll('button, a, div, span')).find((element) => {
            return isVisible(element)
                && !isDisabled(element)
                && normalizeText(element.innerText) === '立即申请';
        }) || null;
    }

    // 在卡片中查找申请按钮，并过滤掉不可投递节点。
    function findApplyElementInCard(card) {
        const clickTarget = resolveApplyClickTarget(card);
        if (!clickTarget || !isApplyButtonElement(clickTarget)) {
            return null;
        }
        return clickTarget;
    }

    // 生成原始候选职位列表，这一步只负责“找得到按钮”，不过早做业务过滤。
    function getApplyCandidates() {
        const dedup = new Map();
        const cards = getJobCards();

        cards.forEach((card) => {
            const applyElement = findApplyElementInCard(card);
            if (!applyElement) {
                return;
            }

            const key = buildJobKey(applyElement);
            if (!key || state.seenJobs.has(key)) {
                return;
            }

            if (!dedup.has(key)) {
                dedup.set(key, {
                    key,
                    card,
                    href: getCardHref(card),
                    isInternal: isInternalDirectCard(card),
                    element: applyElement,
                    text: normalizeText(applyElement.innerText),
                    cardText: normalizeText(card.innerText || '')
                });
            }
        });

        return Array.from(dedup.values());
    }

    // 将时间文本转换为当天零点，便于按天计算年龄。
    function toDayStart(date) {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    }

    // 从“更新于05-19”这类文本中提取发布日期。
    function extractPublishDateFromText(text) {
        const normalized = normalizeText(text);
        const now = new Date();
        const today = toDayStart(now);

        if (normalized.includes('更新于今天')) {
            return today;
        }
        if (normalized.includes('更新于昨天')) {
            return new Date(today.getTime() - 86400000);
        }

        let match = normalized.match(/更新于\s*(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (match) {
            return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        }

        match = normalized.match(/更新于\s*(\d{1,2})-(\d{1,2})/);
        if (match) {
            let year = now.getFullYear();
            let date = new Date(year, Number(match[1]) - 1, Number(match[2]));
            if (date.getTime() > today.getTime() + 86400000) {
                year -= 1;
                date = new Date(year, Number(match[1]) - 1, Number(match[2]));
            }
            return date;
        }

        return null;
    }

    // 读取并缓存职位详情页元信息，目前主要用于“发布时间过滤”。
    async function getJobMetaByHref(href) {
        if (!href || !isInternalJobHref(href) || isExternalJobHref(href)) {
            return null;
        }

        if (state.jobMetaCache.has(href)) {
            return state.jobMetaCache.get(href);
        }

        try {
            const response = await fetch(href, {
                method: 'GET',
                credentials: 'include'
            });
            const html = await response.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const text = normalizeText(doc.body ? doc.body.innerText : html);
            const publishDate = extractPublishDateFromText(text);

            let publishAgeDays = null;
            if (publishDate) {
                const today = toDayStart(new Date());
                const diffMs = today.getTime() - toDayStart(publishDate).getTime();
                publishAgeDays = Math.max(0, Math.floor(diffMs / 86400000));
            }

            const meta = { publishDate, publishAgeDays };
            state.jobMetaCache.set(href, meta);
            return meta;
        } catch (error) {
            const meta = { publishDate: null, publishAgeDays: null, error: error.message || String(error) };
            state.jobMetaCache.set(href, meta);
            return meta;
        }
    }

    // 将用户输入拆分成多个关键字，支持空格、逗号、顿号、分号、竖线等分隔符。
    function buildKeywordTerms(keywordText) {
        const normalized = normalizeText(keywordText);
        if (!normalized) {
            return [];
        }

        return Array.from(new Set(
            normalized
                .split(/[\s,/|+，。；、\-]+/)
                .map((part) => normalizeText(part).toLowerCase())
                .filter(Boolean)
        ));
    }

    // 根据配置判断岗位文本是否命中关键字，支持“任意一个”与“全部命中”两种模式。
    function doesJobMatchKeywordTerms(card, keywordText, matchMode) {
        const terms = buildKeywordTerms(keywordText);
        if (terms.length === 0) {
            return true;
        }

        const cardText = normalizeText(card.innerText || '').toLowerCase();
        if (matchMode === 'all') {
            return terms.every((term) => cardText.includes(term));
        }
        return terms.some((term) => cardText.includes(term));
    }

    // 将关键字匹配模式转成用户可读文本。
    function getKeywordMatchModeLabel(matchMode) {
        return matchMode === 'all' ? '必须命中全部' : '命中任意一个';
    }

    // 根据面板配置对候选职位做最终过滤。
    async function filterCandidates(candidates, options) {
        const settings = options && options.settings ? options.settings : syncSettingsFromPanel();
        const logSummary = !options || options.logSummary !== false;
        const filtered = [];
        const stats = {
            source: candidates.length,
            internalRemoved: 0,
            ageRemoved: 0,
            keywordRemoved: 0
        };

        for (const item of candidates) {
            if (settings.onlyInternalDirect && !item.isInternal) {
                stats.internalRemoved += 1;
                continue;
            }

            if (settings.filterOldJobs && item.href && isInternalJobHref(item.href) && !isExternalJobHref(item.href)) {
                const meta = await getJobMetaByHref(item.href);
                item.publishAgeDays = meta ? meta.publishAgeDays : null;
                if (typeof item.publishAgeDays === 'number' && item.publishAgeDays > settings.maxPublishDays) {
                    stats.ageRemoved += 1;
                    continue;
                }
            }

            if (settings.filterIrrelevantJobs && !doesJobMatchKeywordTerms(item.card, settings.keywordText, settings.keywordMatchMode)) {
                stats.keywordRemoved += 1;
                continue;
            }

            filtered.push(item);
        }

        if (logSummary && (stats.internalRemoved || stats.ageRemoved || stats.keywordRemoved)) {
            log(`过滤结果: 原始${stats.source}个, 站内过滤${stats.internalRemoved}个, 时效过滤${stats.ageRemoved}个, 关键词过滤${stats.keywordRemoved}个, 保留${filtered.length}个`);
        }

        return filtered;
    }

    // 在正式开始前先做一次页面预检查，帮助用户确认当前配置是否符合预期。
    async function runPrecheck() {
        const settings = syncSettingsFromPanel();
        const cards = getJobCards();
        const rawCandidates = getApplyCandidates();
        const filteredCandidates = await filterCandidates(rawCandidates, { settings, logSummary: false });
        const internalCandidates = rawCandidates.filter((item) => item.isInternal);
        const previewLines = [
            `预检查: 卡片${cards.length}个, 可申请${rawCandidates.length}个, 站内直投${internalCandidates.length}个, 预计投递${filteredCandidates.length}个`
        ];

        if (settings.filterOldJobs) {
            previewLines.push(`预检查配置: 发布时间不超过 ${settings.maxPublishDays} 天`);
        }
        if (settings.filterIrrelevantJobs) {
            const keywordText = settings.keywordText || getSearchKeywordFromPage() || '未填写';
            previewLines.push(`预检查配置: 关键字匹配=${getKeywordMatchModeLabel(settings.keywordMatchMode)}, 关键字=${keywordText}`);
        }
        previewLines.forEach((line) => log(line));
        return {
            cards: cards.length,
            rawCandidates: rawCandidates.length,
            internalCandidates: internalCandidates.length,
            filteredCandidates: filteredCandidates.length
        };
    }

    // 拦截站点可能打开的新标签页，并标记为外链岗位。
    function installOpenInterceptors() {
        if (window.__yjs_open_patched__) {
            return;
        }

        const originalOpen = window.open;
        window.__yjs_open_patched__ = true;

        window.open = function (...args) {
            const newWindow = originalOpen.apply(this, args);
            if (state.applyingNow && newWindow && !newWindow.closed) {
                try {
                    newWindow.close();
                } catch (error) {
                    // 保持静默，外链只需要做标记。
                }
                state.openedNewWindow = true;
            }
            return newWindow;
        };

        document.addEventListener('click', (event) => {
            if (!state.applyingNow) {
                return;
            }
            const target = event.target instanceof Element ? event.target : null;
            if (!target) {
                return;
            }
            if (target.closest('.right-btn')
                || target.closest('.el-dialog__wrapper')
                || target.closest('.el-message-box__wrapper')) {
                return;
            }
            const anchor = target.closest('a[target="_blank"]');
            if (anchor) {
                try {
                    event.preventDefault();
                } catch (error) {
                    // 保持静默，主逻辑只关心状态标记。
                }
                state.openedNewWindow = true;
            }
        }, true);
    }

    // 查找当前可见的主确认按钮，用于处理空文案弹窗。
    function getVisiblePrimaryDialogButton() {
        const selectors = [
            '.el-dialog__wrapper .el-dialog__footer .el-button--primary',
            '.el-dialog__wrapper .dialog-footer .el-button--primary',
            '.el-message-box__wrapper .el-message-box__btns .el-button--primary',
            '.el-message-box .el-button--primary'
        ];

        for (const selector of selectors) {
            const button = Array.from(document.querySelectorAll(selector)).find((element) => {
                return isVisible(element) && !isDisabled(element);
            });
            if (button) {
                return button;
            }
        }

        return null;
    }

    // 处理申请后的后续确认按钮，包括确认弹窗和二次申请按钮。
    async function clickFollowUpApplyButtons() {
        for (let round = 0; round < 5; round += 1) {
            if (!state.running) {
                return;
            }
            if (!await waitIfPaused()) {
                return;
            }
            if (hasDailyLimit()) {
                stopAutoApply(`检测到提示：${DAILY_LIMIT_TEXT}`);
                return;
            }

            const primaryButton = getVisiblePrimaryDialogButton();
            if (primaryButton) {
                safeClick(primaryButton, { scroll: false });
                await sleep(900);
                continue;
            }

            const buttons = Array.from(document.querySelectorAll('button, a, div, span')).filter((element) => {
                const text = normalizeText(element.innerText);
                return isVisible(element)
                    && !isDisabled(element)
                    && text
                    && containsAnyText(text, APPLY_TEXTS)
                    && !text.includes('已投递');
            });

            if (buttons.length === 0) {
                return;
            }

            safeClick(buttons[0], { scroll: false });
            await sleep(LOOP_DELAY_MS);
        }
    }

    // 等待单个岗位投递结果落地。
    async function waitForApplyResult(element, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (!await waitIfPaused()) {
                return 'stopped';
            }
            if (hasDailyLimit()) {
                return 'daily_limit';
            }
            if (state.openedNewWindow) {
                return 'external';
            }
            if (hasAppliedState(element) || hasSuccessHint()) {
                return 'success';
            }
            await sleep(250);
        }
        return 'unknown';
    }

    // 执行单个岗位的投递流程。
    async function applyToCandidate(item) {
        const jobTitle = extractJobTitle(item.element) || item.key;
        const previousScrollY = window.scrollY;

        state.seenJobs.add(item.key);
        state.applyingNow = true;
        state.openedNewWindow = false;

        try {
            if (!await waitIfPaused()) {
                return { jobTitle, result: 'stopped' };
            }
            const clicked = safeClick(item.element);
            if (!clicked) {
                return { jobTitle, result: 'failed' };
            }

            await sleep(POST_APPLY_CLICK_WAIT_MS);

            if (hasDailyLimit()) {
                return { jobTitle, result: 'daily_limit' };
            }

            if (state.openedNewWindow) {
                window.scrollTo({ top: previousScrollY, behavior: 'auto' });
                return { jobTitle, result: 'external' };
            }

            await clickFollowUpApplyButtons();
            const result = await waitForApplyResult(item.element, APPLY_RESULT_TIMEOUT_MS);
            return { jobTitle, result };
        } finally {
            state.applyingNow = false;
        }
    }

    // 生成当前列表的签名，用于判断翻页是否成功。
    function getListSignature() {
        const listRoot = document.querySelector('#list');
        return normalizeText(listRoot ? listRoot.innerText : document.body.innerText).slice(0, 300);
    }

    // 点击下一页并等待列表内容变化。
    async function goToNextPage() {
        const beforeSignature = getListSignature();
        const nextButton = NEXT_PAGE_SELECTORS
            .map((selector) => document.querySelector(selector))
            .find((element) => element && isVisible(element) && !isDisabled(element));

        if (!nextButton) {
            stopAutoApply('未找到下一页按钮，自动投递结束');
            return false;
        }

        safeClick(nextButton);
        log('已点击下一页');

        const start = Date.now();
        while (Date.now() - start < PAGE_CHANGE_TIMEOUT_MS) {
            if (!await waitIfPaused()) {
                return false;
            }
            if (!state.running) {
                return false;
            }
            if (hasDailyLimit()) {
                stopAutoApply(`检测到提示：${DAILY_LIMIT_TEXT}`);
                return false;
            }
            await sleep(500);
            const currentSignature = getListSignature();
            if (currentSignature && currentSignature !== beforeSignature) {
                const pageNumber = detectCurrentPageNumber();
                if (pageNumber > state.stats.currentPage) {
                    setCurrentPageStat(pageNumber);
                } else {
                    setCurrentPageStat(state.stats.currentPage + 1);
                }
                log('下一页加载完成');
                return true;
            }
        }

        stopAutoApply('点击下一页后列表未变化，自动投递结束');
        return false;
    }

    // 自动投递主循环：收集候选、执行过滤、逐个投递、最后翻页。
    async function autoApplyLoop() {
        while (state.running) {
            if (!await waitIfPaused()) {
                break;
            }
            if (!ensureSearchPage()) {
                stopAutoApply('当前不在支持的岗位列表页，请回到搜索结果页、职位推荐页或实习页后再开始');
                break;
            }
            setCurrentPageStat(detectCurrentPageNumber() || state.stats.currentPage);

            if (hasDailyLimit()) {
                stopAutoApply(`检测到提示：${DAILY_LIMIT_TEXT}`);
                break;
            }

            const rawCandidates = getApplyCandidates();
            const currentSettings = syncSettingsFromPanel();
            const candidates = await filterCandidates(rawCandidates, { settings: currentSettings });
            if (candidates.length === 0) {
                log('当前页未找到可投递职位，准备尝试下一页');
                const moved = await goToNextPage();
                if (!moved) {
                    break;
                }
                await sleep(LOOP_DELAY_MS);
                continue;
            }

            log(`当前页找到 ${candidates.length} 个待投递职位`);

            for (const item of candidates) {
                if (!await waitIfPaused()) {
                    break;
                }
                if (!state.running) {
                    break;
                }

                if (hasDailyLimit()) {
                    stopAutoApply(`检测到提示：${DAILY_LIMIT_TEXT}`);
                    break;
                }

                const { jobTitle, result } = await applyToCandidate(item);

                if (result === 'daily_limit' || hasDailyLimit()) {
                    stopAutoApply(`检测到提示：${DAILY_LIMIT_TEXT}`);
                    break;
                }

                if (result === 'external' && state.settings.silentSkipExternal) {
                    incrementStat('skippedCount');
                    closeVisibleDialogs();
                    await sleep(POST_DIALOG_CLOSE_WAIT_MS);
                    continue;
                }

                const ok = result === 'success';
                incrementStat(ok ? 'successCount' : 'failedCount');
                log(`${ok ? '投递成功' : '投递失败'}: ${jobTitle}`);

                closeVisibleDialogs();
                await sleep(POST_DIALOG_CLOSE_WAIT_MS);
            }

            if (!state.running) {
                break;
            }

            const moved = await goToNextPage();
            if (!moved) {
                break;
            }
            await sleep(LOOP_DELAY_MS);
        }
    }

    // 安装页面观察器，运行中如遇到每日上限提示可立即停下。
    function installObserver() {
        if (state.observer) {
            state.observer.disconnect();
        }

        state.observer = new MutationObserver(() => {
            if (state.running && hasDailyLimit()) {
                stopAutoApply(`检测到提示：${DAILY_LIMIT_TEXT}`);
            }
        });

        state.observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    // 让面板支持拖动到任意位置。
    function installPanelDrag(panel, titleNode) {
        titleNode.addEventListener('mousedown', (event) => {
            const rect = panel.getBoundingClientRect();
            const offsetX = event.clientX - rect.left;
            const offsetY = event.clientY - rect.top;

            panel.style.left = `${rect.left}px`;
            panel.style.top = `${rect.top}px`;
            panel.style.right = 'auto';

            const handleMove = (moveEvent) => {
                panel.style.left = `${moveEvent.clientX - offsetX}px`;
                panel.style.top = `${moveEvent.clientY - offsetY}px`;
            };

            const handleUp = () => {
                document.removeEventListener('mousemove', handleMove);
                document.removeEventListener('mouseup', handleUp);
                const latestRect = panel.getBoundingClientRect();
                savePanelPosition(latestRect.left, latestRect.top);
            };

            document.addEventListener('mousemove', handleMove);
            document.addEventListener('mouseup', handleUp, { once: true });
        });
    }

    // 恢复控制面板上次拖动后的位置，避免每次刷新都要重新摆放。
    function restorePanelPosition(panel) {
        const position = loadPanelPosition();
        if (!position) {
            return;
        }
        const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth - 8);
        const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight - 8);
        const left = Math.min(Math.max(0, position.left), maxLeft);
        const top = Math.min(Math.max(0, position.top), maxTop);
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.right = 'auto';
    }

    // 将面板控件节点缓存起来，便于后续读取配置。
    function bindPanelControls(panel) {
        state.controls = {
            filterOldJobs: panel.querySelector('#yjs-filter-old'),
            maxPublishDays: panel.querySelector('#yjs-max-days'),
            filterIrrelevantJobs: panel.querySelector('#yjs-filter-keyword'),
            keywordText: panel.querySelector('#yjs-keyword-text'),
            keywordMatchMode: panel.querySelector('#yjs-keyword-mode'),
            keywordModeHint: panel.querySelector('#yjs-keyword-mode-hint')
        };

        const storedSettings = loadSettingsFromStorage();
        state.settings = { ...DEFAULT_SETTINGS, ...storedSettings };

        if (state.controls.filterOldJobs) {
            state.controls.filterOldJobs.checked = !!state.settings.filterOldJobs;
        }
        if (state.controls.maxPublishDays) {
            state.controls.maxPublishDays.value = String(state.settings.maxPublishDays || DEFAULT_SETTINGS.maxPublishDays);
        }
        if (state.controls.filterIrrelevantJobs) {
            state.controls.filterIrrelevantJobs.checked = !!state.settings.filterIrrelevantJobs;
        }
        if (state.controls.keywordText) {
            state.controls.keywordText.value = state.settings.keywordText || '';
        }
        if (state.controls.keywordMatchMode) {
            state.controls.keywordMatchMode.value = state.settings.keywordMatchMode || DEFAULT_SETTINGS.keywordMatchMode;
        }

        const fallbackKeyword = getSearchKeywordFromPage();
        if (state.controls.keywordText) {
            state.controls.keywordText.placeholder = fallbackKeyword || '默认读取当前搜索关键词';
        }
        updateKeywordModeHint();

        Object.values(state.controls).forEach((control) => {
            if (control) {
                control.addEventListener('change', syncSettingsFromPanel);
                control.addEventListener('input', syncSettingsFromPanel);
            }
        });

        syncSettingsFromPanel();
    }

    // 根据关键字匹配模式切换提示文案，避免严格模式下用户误以为候选数量异常。
    function updateKeywordModeHint() {
        if (!state.controls || !state.controls.keywordModeHint) {
            return;
        }
        const mode = state.controls.keywordMatchMode ? state.controls.keywordMatchMode.value : DEFAULT_SETTINGS.keywordMatchMode;
        if (mode === 'all') {
            state.controls.keywordModeHint.textContent = '当前模式较严格：岗位文本需要同时命中全部关键字，候选数量可能明显减少。';
            state.controls.keywordModeHint.style.display = 'block';
            return;
        }
        state.controls.keywordModeHint.textContent = '';
        state.controls.keywordModeHint.style.display = 'none';
    }

    // 点击按钮后给一个短暂的视觉反馈，避免用户不确定是否已经触发。
    function flashButtonFeedback(button) {
        if (!button) {
            return;
        }
        button.classList.remove('yjs-button-feedback');
        // 强制重排，确保连续点击时动画可重复触发。
        void button.offsetWidth;
        button.classList.add('yjs-button-feedback');
        window.setTimeout(() => {
            button.classList.remove('yjs-button-feedback');
        }, 220);
    }

    // 创建控制面板，并将过滤项暴露给用户手动切换。
    function createPanel() {
        if (document.getElementById('yjs-auto-apply-panel')) {
            return;
        }

        const panel = document.createElement('div');
        panel.id = 'yjs-auto-apply-panel';
        panel.innerHTML = `
            <div id="yjs-auto-apply-title">应届生自动投递</div>
            <div id="yjs-auto-apply-status">状态：待开始</div>
            <div id="yjs-auto-apply-stats">
                <div class="yjs-stat-card"><span class="yjs-stat-label">成功</span><strong id="yjs-stat-success">0</strong></div>
                <div class="yjs-stat-card"><span class="yjs-stat-label">失败</span><strong id="yjs-stat-failed">0</strong></div>
                <div class="yjs-stat-card"><span class="yjs-stat-label">跳过</span><strong id="yjs-stat-skipped">0</strong></div>
                <div class="yjs-stat-card"><span class="yjs-stat-label">当前页</span><strong id="yjs-stat-page">1</strong></div>
            </div>
            <div id="yjs-auto-apply-actions">
                <button id="yjs-auto-apply-start" type="button">开始</button>
                <button id="yjs-auto-apply-pause" type="button">暂停</button>
                <button id="yjs-auto-apply-stop" type="button">停止</button>
                <button id="yjs-auto-apply-clear" type="button">清空记录</button>
            </div>
            <div id="yjs-auto-apply-filters">
                <div class="yjs-filter-row">
                    <label><input id="yjs-filter-old" type="checkbox"> 过滤发布时间超过</label>
                    <input id="yjs-max-days" type="number" min="1" value="30">
                    <span>天</span>
                </div>
                <label><input id="yjs-filter-keyword" type="checkbox"> 启用关键字匹配</label>
                <div class="yjs-filter-row">
                    <span>匹配模式</span>
                    <select id="yjs-keyword-mode">
                        <option value="any">命中任意一个</option>
                        <option value="all">必须命中全部</option>
                    </select>
                </div>
                <div id="yjs-keyword-mode-hint"></div>
                <input id="yjs-keyword-text" type="text" placeholder="多个关键字可用空格、逗号或顿号分隔">
            </div>
            <div id="yjs-auto-apply-tips">先手动登录、搜索岗位、设置筛选条件，再点击开始。</div>
            <pre id="yjs-auto-apply-log"></pre>
        `;

        const style = document.createElement('style');
        style.textContent = `
            #yjs-auto-apply-panel {
                position: fixed;
                top: 90px;
                right: 24px;
                z-index: 999999;
                width: 340px;
                background: rgba(18, 24, 38, 0.94);
                color: #f5f7fa;
                border-radius: 12px;
                box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
                padding: 14px;
                font-size: 14px;
                line-height: 1.5;
            }
            #yjs-auto-apply-title {
                font-size: 16px;
                font-weight: 700;
                margin-bottom: 8px;
                cursor: move;
                user-select: none;
            }
            #yjs-auto-apply-status {
                margin-bottom: 10px;
                color: #69b1ff;
            }
            #yjs-auto-apply-stats {
                display: grid;
                grid-template-columns: repeat(4, minmax(0, 1fr));
                gap: 8px;
                margin-bottom: 10px;
            }
            .yjs-stat-card {
                background: rgba(255, 255, 255, 0.06);
                border-radius: 8px;
                padding: 8px 6px;
                text-align: center;
            }
            .yjs-stat-label {
                display: block;
                font-size: 12px;
                color: #d9d9d9;
                margin-bottom: 4px;
            }
            .yjs-stat-card strong {
                display: block;
                font-size: 16px;
                color: #f5f7fa;
                line-height: 1.2;
            }
            #yjs-auto-apply-actions {
                display: flex;
                gap: 8px;
                margin-bottom: 10px;
            }
            #yjs-auto-apply-actions button {
                flex: 1;
                border: 0;
                border-radius: 7px;
                padding: 6px 8px;
                cursor: pointer;
                font-weight: 600;
                font-size: 12px;
                line-height: 1.2;
                transition: transform 0.12s ease, filter 0.12s ease, box-shadow 0.16s ease, opacity 0.16s ease;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
            }
            #yjs-auto-apply-actions button:hover {
                filter: brightness(1.08);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.28);
            }
            #yjs-auto-apply-actions button:active,
            #yjs-auto-apply-actions button.yjs-button-feedback {
                transform: translateY(1px) scale(0.98);
                filter: brightness(0.92);
                box-shadow: 0 1px 4px rgba(0, 0, 0, 0.22);
            }
            #yjs-auto-apply-actions button:disabled {
                opacity: 0.6;
                box-shadow: none;
            }
            #yjs-auto-apply-actions button:focus-visible {
                outline: 2px solid rgba(255, 255, 255, 0.72);
                outline-offset: 1px;
            }
            #yjs-auto-apply-start {
                background: #1677ff;
                color: #ffffff;
            }
            #yjs-auto-apply-stop {
                background: #ff7875;
                color: #ffffff;
            }
            #yjs-auto-apply-pause {
                background: #faad14;
                color: #ffffff;
            }
            #yjs-auto-apply-clear {
                background: #595959;
                color: #ffffff;
            }
            #yjs-auto-apply-filters {
                display: flex;
                flex-direction: column;
                gap: 6px;
                margin-bottom: 10px;
                padding: 8px;
                border-radius: 8px;
                background: rgba(255, 255, 255, 0.06);
            }
            #yjs-auto-apply-filters label {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 13px;
            }
            .yjs-filter-row {
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 13px;
            }
            #yjs-max-days,
            #yjs-keyword-mode,
            #yjs-keyword-text {
                border: 1px solid rgba(255, 255, 255, 0.15);
                border-radius: 6px;
                background: rgba(0, 0, 0, 0.18);
                color: #f5f7fa;
                padding: 4px 6px;
                font-size: 12px;
            }
            #yjs-max-days {
                width: 56px;
            }
            #yjs-keyword-mode {
                flex: 1;
            }
            #yjs-keyword-text {
                width: 100%;
                box-sizing: border-box;
            }
            #yjs-keyword-mode-hint {
                display: none;
                font-size: 12px;
                line-height: 1.5;
                color: #ffd591;
                background: rgba(250, 140, 22, 0.12);
                border: 1px solid rgba(250, 140, 22, 0.24);
                border-radius: 6px;
                padding: 6px 8px;
            }
            #yjs-auto-apply-tips {
                font-size: 12px;
                color: #d9d9d9;
                margin-bottom: 8px;
            }
            #yjs-auto-apply-log {
                max-height: 220px;
                overflow: auto;
                background: rgba(255, 255, 255, 0.06);
                border-radius: 8px;
                padding: 8px;
                white-space: pre-wrap;
                word-break: break-word;
                margin: 0;
                color: #e6f4ff;
            }
        `;

        document.head.appendChild(style);
        document.body.appendChild(panel);
        restorePanelPosition(panel);

        state.panel = panel;
        state.statusNode = panel.querySelector('#yjs-auto-apply-status');
        state.logNode = panel.querySelector('#yjs-auto-apply-log');
        state.pauseButton = panel.querySelector('#yjs-auto-apply-pause');
        state.statNodes = {
            successCount: panel.querySelector('#yjs-stat-success'),
            failedCount: panel.querySelector('#yjs-stat-failed'),
            skippedCount: panel.querySelector('#yjs-stat-skipped'),
            currentPage: panel.querySelector('#yjs-stat-page')
        };

        bindPanelControls(panel);
        installPanelDrag(panel, panel.querySelector('#yjs-auto-apply-title'));
        resetRuntimeStats();
        updatePauseButton();

        panel.querySelector('#yjs-auto-apply-start').addEventListener('click', async (event) => {
            flashButtonFeedback(event.currentTarget);
            syncSettingsFromPanel();

            if (state.running) {
                if (state.paused) {
                    resumeAutoApply();
                    return;
                }
                log('自动投递已在运行中');
                return;
            }
            if (!ensureSearchPage()) {
                updateStatus('状态：请先进入岗位列表页', '#ff4d4f');
                log('请先在应届生站内完成登录、搜索和筛选，并停留在搜索结果页、职位推荐页或实习页');
                return;
            }

            const precheck = await runPrecheck();
            if (precheck.filteredCandidates === 0) {
                updateStatus('状态：预检查未发现可投递岗位', '#fa8c16');
            }

            resetRuntimeStats();
            state.running = true;
            state.paused = false;
            updateStatus('状态：运行中', '#52c41a');
            updatePauseButton();
            log('开始自动投递');

            state.loopPromise = autoApplyLoop().catch((error) => {
                stopAutoApply(`脚本异常停止: ${error.message || error}`);
            });
            await state.loopPromise;
        });

        panel.querySelector('#yjs-auto-apply-pause').addEventListener('click', (event) => {
            flashButtonFeedback(event.currentTarget);
            if (!state.running) {
                return;
            }
            if (state.paused) {
                resumeAutoApply();
                return;
            }
            pauseAutoApply();
        });

        panel.querySelector('#yjs-auto-apply-stop').addEventListener('click', (event) => {
            flashButtonFeedback(event.currentTarget);
            stopAutoApply('用户手动停止');
        });

        panel.querySelector('#yjs-auto-apply-clear').addEventListener('click', (event) => {
            flashButtonFeedback(event.currentTarget);
            state.seenJobs.clear();
            state.logLines = [];
            resetRuntimeStats();
            if (state.logNode) {
                state.logNode.textContent = '';
            }
            log('已清空本轮投递记录');
        });
    }

    // 初始化脚本入口。
    function init() {
        createPanel();
        installObserver();
        installOpenInterceptors();
        log('脚本已加载，等待开始');
        if (!ensureSearchPage()) {
            updateStatus('状态：当前不是支持的岗位列表页', '#fa8c16');
        }
    }

    // 根据页面加载时机执行初始化，避免过早访问 DOM。
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
