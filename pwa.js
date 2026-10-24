(function registerPolySokoPwa() {
    if (!("serviceWorker" in navigator)) return;

    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js?v=13", { scope: "./", updateViaCache: "none" }).catch((err) => {
            console.warn("PWA service worker registration failed:", err.message);
        });
    });
})();
