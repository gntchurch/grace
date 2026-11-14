const CACHE_NAME = "church-gateway-v26";
let activeClientRoute = "/";
let activeClientVisible = false;
let latestExplicitUnread = 0;
const recentNotificationDedup = new Map();

function stripUrlsFromText(text, fallback) {
  const raw = String(text || "").trim();
  if (!raw) return fallback || "";
  const cleaned = raw
    .replace(/https?:\/\/[^\s)\]}>"']+/gi, "")
    .replace(/\bwww\.[^\s)\]}>"']+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback || "";
}

async function updateSwAppBadge(explicitCount) {
  try {
    if (typeof explicitCount === "number" && explicitCount >= 0) {
      latestExplicitUnread = Math.floor(explicitCount);
    }
    const list = self.registration.getNotifications ? await self.registration.getNotifications() : [];
    let activeTrayCount = 0;
    if (Array.isArray(list)) {
      for (const n of list) {
        const gc = n && n.data && typeof n.data.groupCount === "number" ? n.data.groupCount : 1;
        activeTrayCount += Math.max(1, gc);
      }
    }
    const badgeCount = Math.max(latestExplicitUnread, activeTrayCount);
    if (self.navigator) {
      if (badgeCount > 0 && typeof self.navigator.setAppBadge === "function") {
        await self.navigator.setAppBadge(badgeCount);
      } else if (badgeCount <= 0 && typeof self.navigator.clearAppBadge === "function") {
        await self.navigator.clearAppBadge();
      }
    }
    try {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientList) {
        try {
          client.postMessage({ type: "CC_APPLY_WINDOW_BADGE", count: badgeCount });
        } catch {}
      }
    } catch {}
  } catch {}
}

async function showGroupedSwNotification(opts, fromPushEvent = false) {
  const baseTitle = stripUrlsFromText(opts.title, "은혜와진리교회 알림").replace(/\s*\(\d+개?\)$/, "");
  const cleanBody = stripUrlsFromText(opts.body, "새 알림이 도착했습니다.");
  const groupKey =
    typeof opts.tag === "string" && opts.tag
      ? opts.tag
      : opts.conversationId
        ? "chat-msg-" + opts.conversationId
        : "church-notify";
  const inferredConvId =
    opts.conversationId || (groupKey.startsWith("chat-msg-") ? groupKey.slice("chat-msg-".length) : null);

  // 소켓과 Web Push가 동시에 도착할 때 동일 메시지(messageId)가 중복 카운트되지 않도록 보호
  const now = Date.now();
  for (const [k, ts] of recentNotificationDedup.entries()) {
    if (now - ts > 8000) recentNotificationDedup.delete(k);
  }
  const dedupKey = opts.messageId ? `msg:${opts.messageId}` : null;
  const alreadyShownRecently = Boolean(dedupKey && recentNotificationDedup.has(dedupKey));
  if (alreadyShownRecently && !fromPushEvent) {
    return;
  }
  if (dedupKey) {
    recentNotificationDedup.set(dedupKey, now);
  }

  const targetUrl = opts.url || "/prayers";
  const vibratePattern = Array.isArray(opts.vibrate) ? opts.vibrate : [250, 100, 250, 100, 300];
  const isChatMessage = Boolean(inferredConvId) || groupKey.startsWith("chat-msg-");

  // 사용자가 현재 앱(메시지 화면 등)을 켜서 보고 있는 포그라운드 상태일 때는 상단 OS 알람이 중복으로 울리지 않도록 생략
  if (isChatMessage) {
    try {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const anyWindowVisible = Array.isArray(clientList) && clientList.some((c) => c.visibilityState === "visible");
      if (anyWindowVisible && activeClientVisible) {
        return;
      }
    } catch {}
  }

  let groupCount = 1;
  let lines = [cleanBody];
  let reuseExistingTag = null;
  try {
    if (self.registration.getNotifications) {
      const allActive = await self.registration.getNotifications();
      if (Array.isArray(allActive) && allActive.length > 0) {
        // 안드로이드 최대 알림 개수 제한(24개)에 걸려 새 알림이 누락되지 않도록 오래된 알림 정리
        if (allActive.length >= 18) {
          for (const oldN of allActive.slice(0, allActive.length - 12)) {
            try {
              oldN.close();
            } catch {}
          }
        }
        const sameGroup = allActive.filter(
          (n) =>
            (n.data && n.data.groupKey === groupKey) ||
            (inferredConvId && n.data && n.data.conversationId === inferredConvId) ||
            n.tag === groupKey ||
            (typeof n.tag === "string" && n.tag.startsWith(groupKey + "-")),
        );
        if (sameGroup.length > 0) {
          const prev = sameGroup[sameGroup.length - 1];
          const prevData = prev.data || {};
          const prevCount = typeof prevData.groupCount === "number" ? prevData.groupCount : sameGroup.length;
          const prevLines =
            Array.isArray(prevData.lines) && prevData.lines.length > 0
              ? prevData.lines
              : prev.body
                ? String(prev.body).split("\n").filter(Boolean)
                : [];
          if (alreadyShownRecently) {
            groupCount = prevCount;
            lines = prevLines.length > 0 ? prevLines : [cleanBody];
            reuseExistingTag = prev.tag || null;
          } else {
            groupCount = prevCount + 1;
            lines = [...prevLines, cleanBody].slice(-5);
            for (const oldNotif of sameGroup) {
              try {
                oldNotif.close();
              } catch {}
            }
          }
        }
      }
    }
  } catch {}

  const displayTitle = groupCount > 1 ? `${baseTitle} (${groupCount}개)` : baseTitle;
  const displayBody = lines.join("\n");
  const uniqueNotificationTag =
    reuseExistingTag || `${groupKey}-${now}-${Math.random().toString(36).slice(2, 7)}`;

  const fullOptions = {
    body: displayBody,
    icon: "./notification-icon.png?v=19",
    badge: "./notification-badge.png?v=19",
    tag: uniqueNotificationTag,
    renotify: !alreadyShownRecently,
    requireInteraction: isChatMessage ? true : Boolean(opts.requireInteraction),
    silent: alreadyShownRecently,
    vibrate: alreadyShownRecently ? [] : vibratePattern,
    data: {
      url: targetUrl,
      conversationId: inferredConvId,
      groupKey,
      groupCount,
      lines,
    },
  };

  const safeOptions = {
    body: displayBody,
    icon: "./notification-icon.png?v=19",
    tag: uniqueNotificationTag,
    data: {
      url: targetUrl,
      conversationId: inferredConvId,
      groupKey,
      groupCount,
      lines,
    },
  };

  await self.registration
    .showNotification(displayTitle, fullOptions)
    .catch(() => self.registration.showNotification(displayTitle, safeOptions))
    .catch(() => {});
  await updateSwAppBadge();
}

const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./favicon.png",
  "./apple-touch-icon.png",
  "./pwa-192.png",
  "./pwa-512.png",
  "./notification-badge.png",
  "./notification-icon.png",
  "./logo-emblem.png",
  "./logo-bottom.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {}),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (
    url.pathname.endsWith("public-url.txt") ||
    event.request.mode === "navigate" ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/index.html")
  ) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" }).catch(() => caches.match(event.request)),
    );
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data.type !== "string") return;
  if (data.type === "CC_SW_STATE") {
    if (typeof data.route === "string") activeClientRoute = data.route;
    if (typeof data.visible === "boolean") activeClientVisible = data.visible;
  } else if (data.type === "CC_SET_APP_BADGE") {
    event.waitUntil(updateSwAppBadge(typeof data.count === "number" ? data.count : 0));
  } else if (data.type === "CC_SHOW_GROUPED_NOTIFICATION" && data.payload) {
    event.waitUntil(showGroupedSwNotification(data.payload));
  } else if (data.type === "CC_CLEAR_ROOM_NOTIFICATIONS" && typeof data.conversationId === "string") {
    event.waitUntil(
      (async () => {
        try {
          if (self.registration.getNotifications) {
            const list = await self.registration.getNotifications();
            const roomPrefix = "chat-msg-" + data.conversationId;
            for (const n of list) {
              if (
                (n.data && n.data.conversationId === data.conversationId) ||
                (n.data && n.data.groupKey === roomPrefix) ||
                n.tag === roomPrefix ||
                (typeof n.tag === "string" && n.tag.startsWith(roomPrefix + "-"))
              ) {
                n.close();
              }
            }
          }
          await updateSwAppBadge();
        } catch {}
      })(),
    );
  }
});

// 아이폰(iOS 16.4+ PWA) 및 안드로이드(Chrome/WebAPK) 백그라운드 Web Push 수신 핸들러
self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      try {
        data = { title: "은혜와진리교회 알림", body: event.data.text() };
      } catch {
        data = { title: "은혜와진리교회 알림", body: "새 알림이 도착했습니다." };
      }
    }
  } else {
    data = { title: "은혜와진리교회 알림", body: "새 알림이 도착했습니다." };
  }

  event.waitUntil(
    showGroupedSwNotification(data, true).catch(() => {}),
  );
});

self.addEventListener("notificationclick", (event) => {
  const clickedConvId = event.notification.data && event.notification.data.conversationId;
  const clickedGroupKey = event.notification.data && event.notification.data.groupKey;
  const clickedTag = event.notification.tag;
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/prayers";
  const baseScope = (self.registration && self.registration.scope) ? self.registration.scope : "https://gntchurch.github.io/grace/";
  const openUrl = baseScope.replace(/\/+$/, "") + "/?route=" + encodeURIComponent(targetUrl);

  event.waitUntil(
    (async () => {
      try {
        if (self.registration.getNotifications) {
          const list = await self.registration.getNotifications();
          for (const n of list) {
            if (
              (clickedConvId && n.data && n.data.conversationId === clickedConvId) ||
              (clickedGroupKey && n.data && n.data.groupKey === clickedGroupKey) ||
              (clickedGroupKey && typeof n.tag === "string" && n.tag.startsWith(clickedGroupKey + "-")) ||
              (clickedTag && n.tag === clickedTag)
            ) {
              n.close();
            }
          }
        }
        await updateSwAppBadge();
      } catch {}

      try {
        const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const client of clientList) {
          try {
            client.postMessage({ type: "CC_PUSH_CLICK_NAVIGATE", url: targetUrl });
          } catch {}
          if ("focus" in client) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(openUrl);
        }
      } catch {}
    })(),
  );
});
