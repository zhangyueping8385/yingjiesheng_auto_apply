// ==UserScript==
// @name         应届生搜索页自动投递助手
// @namespace    https://tampermonkey.net/
// @version      0.1.1
// @description  适用于应届生搜索结果页的自动投递脚本。手动登录和筛选后，可自动投递站内直投岗位，支持发布时间过滤和关键词相关性过滤。
// @author       xiaozhang
// @match        https://q.yingjiesheng.com/jobs/search/*
// @match        https://www.yingjiesheng.com/jobs/search/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=yingjiesheng.com
// @license      MIT
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/**
 * 应届生搜索页自动投递助手
 *
 * 脚本定位：
 * - 面向应届生搜索结果页的自动化辅助脚本；
 * - 由用户手动完成登录、搜索和筛选后，再启动自动投递；
 * - 默认仅处理站内直投岗位，并静默跳过外链岗位。
 *
 * 当前能力：
 * - 自动识别当前页可投递岗位；
 * - 自动点击“立即申请”并处理常见确认弹窗；
 * - 支持发布时间过滤；
 * - 支持关键词相关性过滤；
 * - 支持自动翻页、日志展示和本地保存面板设置。
 *
 * 使用说明：
 * 1. 打开应届生职位搜索结果页；
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

    // 控制面板配置在本地存储中的键名，刷新页面后会自动恢复这些设置。
    const SETTINGS_STORAGE_KEY = 'yjs_auto_apply_settings_v1';

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
    // filterIrrelevantJobs: 是否过滤与关键词完全不相关的岗位。
    // keywordText: 关键词过滤使用的关键词，默认读取当前搜索页关键词。
    const DEFAULT_SETTINGS = {
        onlyInternalDirect: true,
        silentSkipExternal: true,
        filterOldJobs: false,
        maxPublishDays: 30,
        filterIrrelevantJobs: false,
        keywordText: ''
    };

    // 运行状态统一收口在一个对象里，便于后续维护与扩展。
    // running: 当前自动投递是否正在运行。
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
    const state = {
        running: false,
        loopPromise: null,
        seenJobs: new Set(),
        observer: null,
        panel: null,
        statusNode: null,
        logNode: null,
        logLines: [],
        applyingNow: false,
        openedNewWindow: false,
        jobMetaCache: new Map(),
        settings: { ...DEFAULT_SETTINGS },
        controls: {}
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
                keywordText: normalizeText(settings.keywordText || '')
            }));
        } catch (error) {
            // 本地存储失败时不阻断主流程。
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
        updateStatus(reason || '已停止', '#ff4d4f');
        log(reason || '自动投递已停止');
    }

    // 判断当前页面是否仍在搜索结果页。
    function ensureSearchPage() {
        return window.location.href.includes('/jobs/search/');
    }

    // 获取职位列表根节点。
    function getListRoot() {
        return document.querySelector('#list');
    }

    // 获取搜索结果页里用户当前输入的关键词。
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
        const fallbackKeyword = getSearchKeywordFromPage();

        state.settings = {
            // 这两个过滤能力固定开启，不再在界面中暴露开关。
            onlyInternalDirect: true,
            silentSkipExternal: true,
            filterOldJobs: !!(state.controls.filterOldJobs && state.controls.filterOldJobs.checked),
            maxPublishDays: Math.max(1, Number(state.controls.maxPublishDays ? state.controls.maxPublishDays.value : DEFAULT_SETTINGS.maxPublishDays) || DEFAULT_SETTINGS.maxPublishDays),
            filterIrrelevantJobs: !!(state.controls.filterIrrelevantJobs && state.controls.filterIrrelevantJobs.checked),
            keywordText: normalizeText(keywordInput ? keywordInput.value : '') || fallbackKeyword
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

    // 优先定位搜索结果主列表的第一层包裹节点。
    function getPrimaryJobWrapper() {
        return document.querySelector('#list > div:first-child');
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

    // 生成关键词过滤所需的匹配词组，策略偏宽松，目标是过滤“完全无关”岗位。
    function buildKeywordTerms(keywordText) {
        const normalized = normalizeText(keywordText).toLowerCase();
        if (!normalized) {
            return [];
        }

        const terms = new Set();
        terms.add(normalized);

        normalized.split(/[\s,/|+，。；、\-]+/).forEach((part) => {
            const token = normalizeText(part);
            if (token.length >= 2) {
                terms.add(token);
            }
        });

        const chineseOnly = normalized.replace(/[^\u4e00-\u9fa5]/g, '');
        if (chineseOnly.length >= 2) {
            for (let i = 0; i < chineseOnly.length - 1; i += 1) {
                terms.add(chineseOnly.slice(i, i + 2));
            }
            for (let i = 0; i < chineseOnly.length - 2; i += 1) {
                terms.add(chineseOnly.slice(i, i + 3));
            }
        }

        return Array.from(terms).filter((item) => item.length >= 2);
    }

    // 判断职位与关键词是否相关，策略是“只过滤完全不相关”的岗位。
    function isJobRelevantToKeyword(card, keywordText) {
        const normalizedKeyword = normalizeText(keywordText);
        if (!normalizedKeyword) {
            return true;
        }

        const cardText = normalizeText(card.innerText || '').toLowerCase();
        const fullKeyword = normalizedKeyword.toLowerCase();
        if (cardText.includes(fullKeyword)) {
            return true;
        }

        const terms = buildKeywordTerms(fullKeyword);
        if (terms.length === 0) {
            return true;
        }

        return terms.some((term) => cardText.includes(term));
    }

    // 根据面板配置对候选职位做最终过滤。
    async function filterCandidates(candidates) {
        const settings = syncSettingsFromPanel();
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

            if (settings.filterIrrelevantJobs && !isJobRelevantToKeyword(item.card, settings.keywordText)) {
                stats.keywordRemoved += 1;
                continue;
            }

            filtered.push(item);
        }

        if (stats.internalRemoved || stats.ageRemoved || stats.keywordRemoved) {
            log(`过滤结果: 原始${stats.source}个, 站内过滤${stats.internalRemoved}个, 时效过滤${stats.ageRemoved}个, 相关性过滤${stats.keywordRemoved}个, 保留${filtered.length}个`);
        }

        return filtered;
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
            if (!ensureSearchPage()) {
                stopAutoApply('当前不在搜索结果页，请回到职位搜索结果页后再开始');
                break;
            }

            if (hasDailyLimit()) {
                stopAutoApply(`检测到提示：${DAILY_LIMIT_TEXT}`);
                break;
            }

            const rawCandidates = getApplyCandidates();
            const candidates = await filterCandidates(rawCandidates);
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
                    closeVisibleDialogs();
                    await sleep(POST_DIALOG_CLOSE_WAIT_MS);
                    continue;
                }

                const ok = result === 'success';
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
            };

            document.addEventListener('mousemove', handleMove);
            document.addEventListener('mouseup', handleUp, { once: true });
        });
    }

    // 将面板控件节点缓存起来，便于后续读取配置。
    function bindPanelControls(panel) {
        state.controls = {
            filterOldJobs: panel.querySelector('#yjs-filter-old'),
            maxPublishDays: panel.querySelector('#yjs-max-days'),
            filterIrrelevantJobs: panel.querySelector('#yjs-filter-keyword'),
            keywordText: panel.querySelector('#yjs-keyword-text')
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

        const fallbackKeyword = getSearchKeywordFromPage();
        if (state.controls.keywordText) {
            state.controls.keywordText.placeholder = fallbackKeyword || '默认读取当前搜索关键词';
        }

        Object.values(state.controls).forEach((control) => {
            if (control) {
                control.addEventListener('change', syncSettingsFromPanel);
                control.addEventListener('input', syncSettingsFromPanel);
            }
        });

        syncSettingsFromPanel();
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
            <div id="yjs-auto-apply-actions">
                <button id="yjs-auto-apply-start" type="button">开始</button>
                <button id="yjs-auto-apply-stop" type="button">停止</button>
                <button id="yjs-auto-apply-clear" type="button">清空记录</button>
            </div>
            <div id="yjs-auto-apply-filters">
                <div class="yjs-filter-row">
                    <label><input id="yjs-filter-old" type="checkbox"> 过滤发布时间超过</label>
                    <input id="yjs-max-days" type="number" min="1" value="30">
                    <span>天</span>
                </div>
                <label><input id="yjs-filter-keyword" type="checkbox"> 过滤与关键词完全不相关岗位</label>
                <input id="yjs-keyword-text" type="text" placeholder="默认读取当前搜索关键词">
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
            #yjs-auto-apply-actions {
                display: flex;
                gap: 8px;
                margin-bottom: 10px;
            }
            #yjs-auto-apply-actions button {
                flex: 1;
                border: 0;
                border-radius: 8px;
                padding: 8px 10px;
                cursor: pointer;
                font-weight: 600;
            }
            #yjs-auto-apply-start {
                background: #1677ff;
                color: #ffffff;
            }
            #yjs-auto-apply-stop {
                background: #ff7875;
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
            #yjs-keyword-text {
                width: 100%;
                box-sizing: border-box;
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

        state.panel = panel;
        state.statusNode = panel.querySelector('#yjs-auto-apply-status');
        state.logNode = panel.querySelector('#yjs-auto-apply-log');

        bindPanelControls(panel);
        installPanelDrag(panel, panel.querySelector('#yjs-auto-apply-title'));

        panel.querySelector('#yjs-auto-apply-start').addEventListener('click', async () => {
            syncSettingsFromPanel();

            if (state.running) {
                log('自动投递已在运行中');
                return;
            }
            if (!ensureSearchPage()) {
                updateStatus('状态：请先进入搜索结果页', '#ff4d4f');
                log('请先在应届生站内完成登录、搜索和筛选，并停留在搜索结果页');
                return;
            }

            state.running = true;
            updateStatus('状态：运行中', '#52c41a');
            log('开始自动投递');

            state.loopPromise = autoApplyLoop().catch((error) => {
                stopAutoApply(`脚本异常停止: ${error.message || error}`);
            });
            await state.loopPromise;
        });

        panel.querySelector('#yjs-auto-apply-stop').addEventListener('click', () => {
            stopAutoApply('用户手动停止');
        });

        panel.querySelector('#yjs-auto-apply-clear').addEventListener('click', () => {
            state.seenJobs.clear();
            state.logLines = [];
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
            updateStatus('状态：当前不是搜索结果页', '#fa8c16');
        }
    }

    // 根据页面加载时机执行初始化，避免过早访问 DOM。
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
