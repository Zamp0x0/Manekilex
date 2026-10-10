/**
 * book-store.js — Reader 模块的 IndexedDB 封装
 *
 * 电子书文件较大，不适合放进 chrome.storage.local，因此使用 IndexedDB。
 * 暴露 window.ZEHBookStore，供 settings.js（书架）与 reader.js（阅读器）共用。
 *
 * 数据安全：所有书籍仅保存在本机 IndexedDB，不上传服务器。
 *
 * 存储结构：
 *   DB:  zeh-reader  (version 1)
 *   store books     keyPath "id"
 *   store bookmarks keyPath "id"，index "bookId"
 */
(function () {
  const DB_NAME = "zeh-reader";
  const DB_VERSION = 1;
  const STORE_BOOKS = "books";
  const STORE_BOOKMARKS = "bookmarks";

  let _dbPromise = null;
  const DEBUG_STORE = (() => {
    try {
      return new URLSearchParams(location.search).get("debug") === "1";
    } catch {
      return false;
    }
  })();

  function storeDebug(...args) {
    if (!DEBUG_STORE) return;
    console.log(...args);
  }

  /** 事务结束才算完成；error / abort（含配额不足）都要让 Promise 结束，不能挂起（R-10） */
  function txError(transaction, fallbackName) {
    return (
      transaction.error ||
      new DOMException(`IndexedDB transaction ${fallbackName || "failed"}`, "AbortError")
    );
  }

  function txDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(txError(transaction, "failed"));
      transaction.onabort = () => reject(txError(transaction, "aborted"));
    });
  }

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_BOOKS)) {
          db.createObjectStore(STORE_BOOKS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_BOOKMARKS)) {
          const bm = db.createObjectStore(STORE_BOOKMARKS, { keyPath: "id" });
          bm.createIndex("bookId", "bookId", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        _dbPromise = null; // 下次调用重试打开
        reject(req.error);
      };
      req.onblocked = () => {
        _dbPromise = null;
        reject(new DOMException("IndexedDB open blocked", "AbortError"));
      };
    });
    return _dbPromise;
  }

  function reqAsPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      const tx = request.transaction;
      if (tx) {
        tx.onabort = () => reject(txError(tx, "aborted"));
      }
    });
  }

  /**
   * 在一个 readwrite 事务里读-改-写若干条记录：mutate(book) 返回 true 表示要写回。
   * 读与写在同一事务内，保证基于最新存储状态，不会用旧列表覆盖别处刚写的字段。
   */
  function updateBooksInTransaction(db, ids, mutate) {
    const transaction = db.transaction(STORE_BOOKS, "readwrite");
    const store = transaction.objectStore(STORE_BOOKS);
    const touched = [];
    ids.forEach((id, index) => {
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const book = getReq.result;
        if (!book) return;
        if (mutate(book, index) !== false) {
          store.put(book);
          touched.push(book);
        }
      };
    });
    return txDone(transaction).then(() => touched);
  }

  function genId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // ── books ─────────────────────────────────────────────────────────────────

  /**
   * 添加一本书。book 至少包含 fileBlob；其余字段会补默认值。
   * 返回写入后的完整 book 对象。
   */
  async function addBook(book) {
    const now = Date.now();
    const record = {
      id: book.id || genId(),
      title: book.title || "未命名书籍",
      author: book.author || "未知作者",
      format: book.format || "epub",
      coverBlob: book.coverBlob || null,
      fileBlob: book.fileBlob,
      addedAt: book.addedAt || now,
      lastReadAt: book.lastReadAt || 0,
      progress: typeof book.progress === "number" ? book.progress : 0,
      currentLocation: book.currentLocation || "",
      sortOrder: typeof book.sortOrder === "number" ? book.sortOrder : undefined,
    };
    if (book.sourceFormat) record.sourceFormat = book.sourceFormat;
    if (book.originalFilename) record.originalFilename = book.originalFilename;
    if (book.convertMode) record.convertMode = book.convertMode;
    if (book.convertedAt) record.convertedAt = book.convertedAt;
    if (typeof record.sortOrder !== "number") {
      record.sortOrder = await getNextSortOrder();
    }
    const db = await openDB();
    const transaction = db.transaction(STORE_BOOKS, "readwrite");
    transaction.objectStore(STORE_BOOKS).put(record);
    await txDone(transaction);
    return record;
  }

  async function getNextSortOrder() {
    const db = await openDB();
    const transaction = db.transaction(STORE_BOOKS, "readonly");
    const list = await reqAsPromise(transaction.objectStore(STORE_BOOKS).getAll());
    let max = -1;
    for (const book of list) {
      if (typeof book.sortOrder === "number" && book.sortOrder > max) {
        max = book.sortOrder;
      }
    }
    return max + 1;
  }

  /** 旧书无 sortOrder 时，按原「最近阅读/添加」顺序一次性补齐 */
  async function ensureBookSortOrders(books) {
    if (!books.length || books.every((b) => typeof b.sortOrder === "number")) {
      return books;
    }
    books.sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt));
    const db = await openDB();
    const transaction = db.transaction(STORE_BOOKS, "readwrite");
    const store = transaction.objectStore(STORE_BOOKS);
    books.forEach((book, index) => {
      book.sortOrder = index;
      store.put(book);
    });
    await txDone(transaction);
    return books;
  }

  async function getAllBooks() {
    const db = await openDB();
    const transaction = db.transaction(STORE_BOOKS, "readonly");
    let list = await reqAsPromise(transaction.objectStore(STORE_BOOKS).getAll());
    list = await ensureBookSortOrders(list);
    list.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    return list;
  }

  async function getBook(id) {
    const db = await openDB();
    const transaction = db.transaction(STORE_BOOKS, "readonly");
    return reqAsPromise(transaction.objectStore(STORE_BOOKS).get(id));
  }

  /** 删除书籍并级联删除其全部书签 */
  async function deleteBook(id) {
    const db = await openDB();
    const transaction = db.transaction([STORE_BOOKS, STORE_BOOKMARKS], "readwrite");
    transaction.objectStore(STORE_BOOKS).delete(id);
    const index = transaction.objectStore(STORE_BOOKMARKS).index("bookId");
    const cursorReq = index.openCursor(IDBKeyRange.only(id));
    cursorReq.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    return txDone(transaction);
  }

  /** 声明当前 Reader 标签为活跃会话（新 tab 打开时调用） */
  async function claimActiveReaderSession(id, sessionId) {
    const db = await openDB();
    const touched = await updateBooksInTransaction(db, [id], (book) => {
      book.activeReaderSessionId = sessionId;
      return true;
    });
    return touched[0] || null;
  }

  /** 允许写入阅读位置的原因（reader.js 也用这一份）；resize / relocated 等程序化变化不写 */
  const SAVE_ALLOWED_REASONS = Object.freeze(["scroll-debounce", "back-to-shelf", "toc-jump", "bookmark-jump"]);

  function isSaveAllowedPersistReason(reason) {
    return SAVE_ALLOWED_REASONS.includes(reason);
  }

  /** 更新阅读进度 / 位置 / 最近阅读时间 */
  async function updateBookProgress(id, patch, meta = {}) {
    const persistReason = patch.persistReason || meta.persistReason || "";
    if (!isSaveAllowedPersistReason(persistReason)) {
      console.warn(
        `[ZEH_POS] BookStore reject progress update disallowed reason=${persistReason || "missing"}`
      );
      return { book: null, skipped: true, reason: "disallowed-persist-reason" };
    }

    const forceWrite = patch.forceWrite === true || meta.force === true;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_BOOKS, "readwrite");
      transaction.onerror = () => reject(txError(transaction, "failed"));
      transaction.onabort = () => reject(txError(transaction, "aborted"));
      const store = transaction.objectStore(STORE_BOOKS);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const book = getReq.result;
        if (!book) {
          resolve(null);
          return;
        }

        const incomingSession = patch.updatedBySessionId || meta.readerSessionId;
        const activeSession = book.activeReaderSessionId;
        const isActiveSession = !activeSession || !incomingSession || incomingSession === activeSession;

        // force 只跳过阅读页的节流，不跳过会话检查：旧标签页不能覆盖新标签页的位置
        if (incomingSession && activeSession && incomingSession !== activeSession) {
          console.warn("[BookStore] reject progress update", {
            reason: "stale-session",
            incomingLastReadAt: patch.lastReadAt,
            existingLastReadAt: book.lastReadAt,
            incomingSession,
            activeSession,
          });
          resolve({ book, skipped: true, reason: "stale-session" });
          return;
        }

        if (typeof patch.progress === "number") book.progress = patch.progress;
        if (patch.currentLocation !== undefined) book.currentLocation = patch.currentLocation;
        if (typeof patch.currentSpineIndex === "number") {
          book.currentSpineIndex = patch.currentSpineIndex;
        }
        if (typeof patch.chapterScrollRatio === "number") {
          book.chapterScrollRatio = patch.chapterScrollRatio;
        }
        if (typeof patch.totalSpineItems === "number") {
          book.totalSpineItems = patch.totalSpineItems;
        }
        if (patch.readingAnchor && typeof patch.readingAnchor === "object") {
          book.readingAnchor = patch.readingAnchor;
        }
        book.lastReadAt = patch.lastReadAt || Date.now();
        if (incomingSession) book.progressUpdatedBySessionId = incomingSession;

        store.put(book);
        transaction.oncomplete = () => {
          storeDebug("[BookStore] progress updated", {
            currentSpineIndex: book.currentSpineIndex,
            chapterScrollRatio: book.chapterScrollRatio,
            progress: book.progress,
            readingAnchorPrefix: (book.readingAnchor && book.readingAnchor.prefix || "").slice(0, 40),
            lastReadAt: book.lastReadAt,
            updatedBySessionId: book.progressUpdatedBySessionId,
            isActiveSession,
            forceWrite,
          });
          resolve({ book, skipped: false, isActiveSession });
        };
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  // ── bookmarks ───────────────────────────────────────────────────────────────

  async function addBookmark(bm) {
    const record = {
      id: bm.id || genId(),
      bookId: bm.bookId,
      label: bm.label || "未命名书签",
      location: bm.location || "",
      excerpt: bm.excerpt || "",
      createdAt: bm.createdAt || Date.now(),
    };
    const db = await openDB();
    const transaction = db.transaction(STORE_BOOKMARKS, "readwrite");
    transaction.objectStore(STORE_BOOKMARKS).put(record);
    await txDone(transaction);
    return record;
  }

  async function getBookmarks(bookId) {
    const db = await openDB();
    const transaction = db.transaction(STORE_BOOKMARKS, "readonly");
    const index = transaction.objectStore(STORE_BOOKMARKS).index("bookId");
    const list = await reqAsPromise(index.getAll(IDBKeyRange.only(bookId)));
    list.sort((a, b) => a.createdAt - b.createdAt);
    return list;
  }

  async function renameBookmark(id, label) {
    const db = await openDB();
    const transaction = db.transaction(STORE_BOOKMARKS, "readwrite");
    const store = transaction.objectStore(STORE_BOOKMARKS);
    let updated = null;
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const bm = getReq.result;
      if (!bm) return;
      bm.label = label;
      store.put(bm);
      updated = bm;
    };
    await txDone(transaction);
    return updated;
  }

  async function deleteBookmark(id) {
    const db = await openDB();
    const transaction = db.transaction(STORE_BOOKMARKS, "readwrite");
    transaction.objectStore(STORE_BOOKMARKS).delete(id);
    await txDone(transaction);
  }

  /**
   * 按 id 数组顺序更新书架 sortOrder（0 起）。
   * 读与写在同一个 readwrite 事务里完成：只改 sortOrder，其余字段（阅读进度、会话标记等）
   * 取存储里的最新值，不会被书架页的旧列表覆盖（R-12）。
   */
  async function reorderBooks(orderedIds) {
    if (!Array.isArray(orderedIds) || !orderedIds.length) return;
    const db = await openDB();
    const uniqueIds = [...new Set(orderedIds)];
    await updateBooksInTransaction(db, uniqueIds, (book, index) => {
      if (book.sortOrder === index) return false;
      book.sortOrder = index;
      return true;
    });
  }

  async function updateBookTitle(id, title) {
    const trimmed = String(title || "").trim() || "未命名书籍";
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_BOOKS, "readwrite");
      transaction.onerror = () => reject(transaction.error);
      const store = transaction.objectStore(STORE_BOOKS);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const book = getReq.result;
        if (!book) {
          resolve(null);
          return;
        }
        book.title = trimmed;
        store.put(book);
        transaction.oncomplete = () => resolve(book);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  /**
   * 重置书架全部图书的阅读进度（不删 EPUB/封面/书签/toc 等）。
   * 仅清零 progress、位置字段与会话相关进度标记。
   */
  async function resetAllReadingProgress() {
    const db = await openDB();
    const transaction = db.transaction(STORE_BOOKS, "readwrite");
    const store = transaction.objectStore(STORE_BOOKS);
    let count = 0;
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) return;
      const book = cursor.value;
      book.progress = 0;
      book.currentSpineIndex = 0;
      book.chapterScrollRatio = 0;
      book.currentLocation = "";
      book.lastReadAt = 0;
      delete book.readingAnchor;
      delete book.activeReaderSessionId;
      delete book.progressUpdatedBySessionId;
      cursor.update(book);
      count++;
      cursor.continue();
    };
    await txDone(transaction);

    return { count };
  }

  window.ZEHBookStore = {
    addBook,
    getAllBooks,
    getBook,
    deleteBook,
    updateBookProgress,
    claimActiveReaderSession,
    reorderBooks,
    updateBookTitle,
    resetAllReadingProgress,
    addBookmark,
    getBookmarks,
    renameBookmark,
    deleteBookmark,
    genId,
    SAVE_ALLOWED_REASONS,
    isSaveAllowedPersistReason,
  };
})();
