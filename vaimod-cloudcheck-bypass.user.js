// ==UserScript==
// @name         VaIMod CloudCheck Bypass（云校验绕过）
// @namespace    vaimod-cloudcheck-bypass
// @version      1.0.0
// @description  不改 VaIMod 任何代码：拦截 ccw 学生资料云接口 community-web.ccw.site/students/profile，伪造成功响应，让 VaIMod 的启动校验直接通过，正常挂载面板。
// @match        *://www.ccw.site/*
// @match        *://ccw.site/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // VaIMod guard.ts 启动时会 POST https://community-web.ccw.site/students/profile（带 cookie）
  // 并解析响应中的 studentOid：请求失败/无 oid → shouldHalt()=true → 页面被 terminate。
  // 本脚本在 document-start 抢先 hook window.fetch，命中该接口时直接返回伪造成功响应。

  // 伪造的 studentOid（24 位 hex，避开原黑名单 670b895b19f4df62e8081d80；原黑名单比对已按用户要求移除，任意格式均可）
  const FAKE_OID = '00112233445566778899aabb';

  const FAKE_RESPONSE_BODY = JSON.stringify({
    code: 0,
    body: { studentOid: FAKE_OID },
  });

  const origFetch = window.fetch.bind(window);

  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let url = '';
    try {
      url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : String((input as Request)?.url ?? '');
    } catch {
      /* ignore */
    }

    if (url.includes('/students/profile')) {
      console.warn('[VaIMod Bypass] 拦截云校验请求 → 返回伪造成功:', url);
      return Promise.resolve(
        new Response(FAKE_RESPONSE_BODY, {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }

    return origFetch(input, init);
  };
})();
