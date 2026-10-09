// Injected into eyeREST (Tauri app) via an LC_LOAD_DYLIB load command.
//
// 1. Always-on-top Tao windows (the blink smile overlay) join all Spaces,
//    including other apps' full-screen Spaces, at status-bar level.
// 2. The app is forced to be a menu-bar-only agent (no Dock icon); macOS only
//    shows such overlays over full-screen apps for agent apps.
// 3. The main window: minimize hides the window (reopen it via the menu-bar
//    icon's Open), close quits the app after a confirmation. The window's traffic lights are HTML
//    calling Tauri's minimize() (-> miniaturize:) and hide() (-> orderOut:).
// 4. JS injection (fsaux-inject.js): automatic camera, smile while no face is
//    detected, auto-start of monitoring.
// 5. Menu-bar icon menu: Open / Start / Stop / Exit.
// 6. The overlay is re-centered on the current screen whenever it is shown.
// 7. Usage statistics: screen-on time per day from the power-management log,
//    screen sleep/wake and every appearance of the smile are reported to the
//    JS, which keeps the daily statistics and draws them.
// 8. Run at startup: a login item (launch agent in the bundle, registered with
//    SMAppService) starts the app with --fsaux-autostart (only logged). A
//    second copy of the app quits.
// 9. The main window stays hidden at launch (monitoring starts by itself); it
//    opens via the menu's Open, by opening the app again while it runs, or
//    when the JS asks (camera permission / first-run intro still pending).
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <WebKit/WebKit.h>
#import <ServiceManagement/ServiceManagement.h>

static const NSWindowCollectionBehavior kAdd =
    NSWindowCollectionBehaviorCanJoinAllSpaces |
    NSWindowCollectionBehaviorFullScreenAuxiliary |
    NSWindowCollectionBehaviorStationary |
    NSWindowCollectionBehaviorIgnoresCycle;
static const NSWindowCollectionBehavior kRemove =
    NSWindowCollectionBehaviorFullScreenPrimary |
    NSWindowCollectionBehaviorFullScreenNone |
    NSWindowCollectionBehaviorMoveToActiveSpace |
    NSWindowCollectionBehaviorManaged;

static void (*origSetLevel)(id, SEL, NSWindowLevel);
static void (*origSetCB)(id, SEL, NSWindowCollectionBehavior);
static BOOL (*origSetPolicy)(id, SEL, NSApplicationActivationPolicy);
static void (*origPerformClose)(id, SEL, id);
static void (*origClose)(id, SEL);
static void (*origOrderOut)(id, SEL, id);
static void (*origMiniaturize)(id, SEL, id);
static void (*origPerformMiniaturize)(id, SEL, id);
static void (*origDeminiaturize)(id, SEL, id);
static BOOL (*origIsMiniaturized)(id, SEL);

// Log file: ~/Library/Containers/com.vinlemon.eyeREST/Data/tmp/fsaux.log
static void fsaux_log(NSWindow *w, NSString *what) {
    NSString *p = [NSTemporaryDirectory() stringByAppendingPathComponent:@"fsaux.log"];
    NSString *line = [NSString stringWithFormat:@"%@ %@ %@ title=%@ level=%ld cb=0x%lx style=0x%lx frame=%@\n",
        [NSDate date], what, NSStringFromClass([w class]), w.title, (long)w.level,
        (unsigned long)w.collectionBehavior, (unsigned long)w.styleMask, NSStringFromRect(w.frame)];
    NSFileHandle *h = [NSFileHandle fileHandleForWritingAtPath:p];
    if (!h) { [line writeToFile:p atomically:NO encoding:NSUTF8StringEncoding error:nil]; return; }
    [h seekToEndOfFile]; [h writeData:[line dataUsingEncoding:NSUTF8StringEncoding]]; [h closeFile];
}

static BOOL fsaux_isTao(NSWindow *w) {
    return [NSStringFromClass([w class]) hasPrefix:@"Tao"];
}

static BOOL quitting;

// Until the user opens it, the main window stays hidden after launch.
static BOOL keepMainHidden = YES;

// The smile overlay: the Tao window the app itself makes always-on-top.
static __weak NSWindow *overlayWindow;

static BOOL fsaux_isOverlay(NSWindow *w) {
    return w && w == overlayWindow;
}

static BOOL fsaux_isMainWindow(NSWindow *w) {
    // The main window has no native title bar (its traffic lights are HTML),
    // so it is identified as "the Tao window that isn't the overlay".
    return !quitting && fsaux_isTao(w) && !fsaux_isOverlay(w);
}

// --- 1. overlay over full-screen Spaces ---

static const NSWindowLevel kOverlayLevel = NSStatusWindowLevel;

static void hookSetLevel(NSWindow *self, SEL _cmd, NSWindowLevel level) {
    if (!overlayWindow && level > NSNormalWindowLevel && fsaux_isTao(self)) overlayWindow = self;
    if (fsaux_isOverlay(self)) {
        origSetLevel(self, _cmd, MAX(level, kOverlayLevel));
        origSetCB(self, @selector(setCollectionBehavior:), (self.collectionBehavior & ~kRemove) | kAdd);
        fsaux_log(self, @"setLevel(top)");
    } else {
        origSetLevel(self, _cmd, level);
    }
}

static void hookSetCB(NSWindow *self, SEL _cmd, NSWindowCollectionBehavior cb) {
    if (fsaux_isOverlay(self)) cb = (cb & ~kRemove) | kAdd;
    origSetCB(self, _cmd, cb);
}

// The app centers the overlay once, when it creates it, so after switching
// between a big and a small display it ends up off-center. Re-center it on the
// screen in use (the one with the active app's focused window) whenever it
// is shown and whenever the display setup changes.
static void (*origOrderWindow)(id, SEL, NSWindowOrderingMode, NSInteger);
static void (*origOrderFrontRegardless)(id, SEL);

static void fsaux_centerOverlay(NSWindow *w) {
    NSScreen *screen = [NSScreen mainScreen] ?: w.screen;
    if (!screen) return;
    NSRect vis = screen.frame, f = w.frame;  // same as the app's own centering
    NSPoint o = NSMakePoint(round(NSMidX(vis) - f.size.width / 2), round(NSMidY(vis) - f.size.height / 2));
    if (!NSEqualPoints(o, f.origin)) {
        [w setFrameOrigin:o];
        fsaux_log(w, @"overlay centered");
    }
}

static void fsaux_runJS(NSString *js);

// The overlay just went from hidden to visible: one smile, counted by the JS
// unless it is the no-face smile.
static void fsaux_overlayShowing(NSWindow *w) {
    fsaux_centerOverlay(w);
    if (!w.isVisible) fsaux_runJS(@"window.__fsaux && window.__fsaux.smileShown()");
}

static BOOL fsaux_isMainWindow(NSWindow *w);
static BOOL fsaux_keepHidden(NSWindow *w);

static void hookOrderWindow(NSWindow *self, SEL _cmd, NSWindowOrderingMode mode, NSInteger rel) {
    if (mode != NSWindowOut && fsaux_isOverlay(self)) fsaux_overlayShowing(self);
    if (mode != NSWindowOut && fsaux_keepHidden(self)) return;
    origOrderWindow(self, _cmd, mode, rel);
}

static void hookOrderFrontRegardless(NSWindow *self, SEL _cmd) {
    if (fsaux_isOverlay(self)) fsaux_overlayShowing(self);
    if (fsaux_keepHidden(self)) return;
    origOrderFrontRegardless(self, _cmd);
}

static void fsaux_observeScreenChanges(void) {
    [[NSNotificationCenter defaultCenter] addObserverForName:NSApplicationDidChangeScreenParametersNotification
        object:nil queue:nil usingBlock:^(NSNotification *n) {
            if (overlayWindow) fsaux_centerOverlay(overlayWindow);
        }];
}

// While eyeREST is the active app and its main window is focused, that window
// sits just above the overlay so the smile never blocks the settings; otherwise
// it is an ordinary window again. (An agent app's window can stay key while the
// app is inactive, so app activation is checked too.)
static void fsaux_updateMainWindowLevel(void) {
    for (NSWindow *w in NSApp.windows) {
        if (!fsaux_isMainWindow(w)) continue;
        BOOL front = NSApp.isActive && w.isKeyWindow && w.isVisible;
        NSWindowLevel want = front ? kOverlayLevel + 1 : NSNormalWindowLevel;
        if (w.level != want) origSetLevel(w, @selector(setLevel:), want);
    }
}

static void fsaux_observeMainWindowFocus(void) {
    NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
    for (NSNotificationName name in @[NSWindowDidBecomeKeyNotification, NSWindowDidResignKeyNotification,
                                      NSApplicationDidBecomeActiveNotification, NSApplicationDidResignActiveNotification]) {
        [nc addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification *n) {
            fsaux_updateMainWindowLevel();
        }];
    }
}

// --- 2. no Dock icon ---

static BOOL hookSetPolicy(NSApplication *self, SEL _cmd, NSApplicationActivationPolicy p) {
    return origSetPolicy(self, _cmd, NSApplicationActivationPolicyAccessory);
}

// --- 3. minimize = hide, close = quit ---

static void fsaux_quit(NSWindow *w, NSString *why) {
    quitting = YES;
    fsaux_log(w, why);
    origOrderOut(w, @selector(orderOut:), nil);
    // We are inside tao's event handler (it holds a lock that terminate: needs),
    // so quit on the next run-loop turn; hard-exit if that doesn't finish.
    dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; });
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ exit(0); });
}

// Every user-initiated exit asks first (logout/shutdown don't go through here).
// The alert runs on the next run-loop turn, outside tao's event handler.
static NSString *uiLang = @"en";  // app language code, reported by the JS

// Exit dialog texts: title, message, quit, cancel.
static NSArray<NSString *> *fsaux_quitTexts(void) {
    static NSDictionary<NSString *, NSArray<NSString *> *> *texts;
    if (!texts) texts = @{
        @"en": @[@"Quit eyeREST?", @"Your blinking will no longer be monitored.", @"Quit", @"Cancel"],
        @"de": @[@"eyeREST beenden?", @"Ihre Blinzler werden dann nicht mehr überwacht.", @"Beenden", @"Abbrechen"],
        @"it": @[@"Uscire da eyeREST?", @"I tuoi battiti di ciglia non saranno più monitorati.", @"Esci", @"Annulla"],
        @"es": @[@"¿Salir de eyeREST?", @"Tus parpadeos dejarán de monitorizarse.", @"Salir", @"Cancelar"],
        @"ru": @[@"Выйти из eyeREST?", @"Моргания больше не будут отслеживаться.", @"Выйти", @"Отменить"],
        @"ja": @[@"eyeREST を終了しますか？", @"まばたきのモニタリングが停止します。", @"終了", @"キャンセル"],
        @"zh": @[@"退出 eyeREST？", @"将不再监测您的眨眼。", @"退出", @"取消"],
    };
    return texts[uiLang] ?: texts[@"en"];
}
static BOOL confirming;

static void fsaux_confirmQuit(NSWindow *w, NSString *why) {
    if (confirming || quitting) return;
    confirming = YES;
    dispatch_async(dispatch_get_main_queue(), ^{
        [NSApp activateIgnoringOtherApps:YES];
        NSAlert *a = [NSAlert new];
        NSArray<NSString *> *tx = fsaux_quitTexts();
        a.messageText = tx[0];
        a.informativeText = tx[1];
        [a addButtonWithTitle:tx[2]];
        [a addButtonWithTitle:tx[3]].keyEquivalent = @"\033";
        // runModal resets the level, and macOS may not let a background agent
        // app come to the front: raise the alert once the modal loop runs.
        [[NSRunLoop mainRunLoop] performInModes:@[NSModalPanelRunLoopMode] block:^{
            a.window.level = NSStatusWindowLevel + 2;  // above the main window and the smile
            [a.window orderFrontRegardless];
            [a.window makeKeyWindow];
        }];
        BOOL quit = [a runModal] == NSAlertFirstButtonReturn;
        confirming = NO;
        if (quit) fsaux_quit(w, why);
        else fsaux_log(w, [why stringByAppendingString:@" cancelled"]);
    });
}

static void hookPerformClose(NSWindow *self, SEL _cmd, id sender) {
    if (fsaux_isMainWindow(self)) return fsaux_confirmQuit(self, @"performClose->quit");
    origPerformClose(self, _cmd, sender);
}

// eyeREST's HTML close button calls Tauri's window.hide(), i.e. orderOut:.
static void hookOrderOut(NSWindow *self, SEL _cmd, id sender) {
    if (fsaux_isMainWindow(self) && self.isVisible) return fsaux_confirmQuit(self, @"orderOut->quit");
    origOrderOut(self, _cmd, sender);
}

static void hookClose(NSWindow *self, SEL _cmd) {
    // Programmatic close (e.g. a custom HTML close button calling window.close()).
    if (fsaux_isMainWindow(self) && self.isVisible) return fsaux_confirmQuit(self, @"close->quit");
    origClose(self, _cmd);
}

// The window hidden by minimize; reported as minimized so the menu-bar icon's
// "if minimized, unminimize" logic brings it back via deminiaturize:.
static __weak NSWindow *hiddenWindow;

static void fsaux_hide(NSWindow *w, NSString *why) {
    fsaux_log(w, why);
    hiddenWindow = w;
    origOrderOut(w, @selector(orderOut:), nil);
}

static BOOL hookIsMiniaturized(NSWindow *self, SEL _cmd) {
    if (self == hiddenWindow && !self.isVisible) return YES;
    return origIsMiniaturized(self, _cmd);
}

static void hookMiniaturize(NSWindow *self, SEL _cmd, id sender) {
    if (fsaux_isMainWindow(self)) return fsaux_hide(self, @"miniaturize->hide");
    origMiniaturize(self, _cmd, sender);
}

static void hookPerformMiniaturize(NSWindow *self, SEL _cmd, id sender) {
    if (fsaux_isMainWindow(self)) return fsaux_hide(self, @"performMiniaturize->hide");
    origPerformMiniaturize(self, _cmd, sender);
}

static void hookDeminiaturize(NSWindow *self, SEL _cmd, id sender) {
    if (self == hiddenWindow) {
        hiddenWindow = nil;
        keepMainHidden = NO;
        fsaux_log(self, @"deminiaturize->show");
        [NSApp activateIgnoringOtherApps:YES];
        [self makeKeyAndOrderFront:nil];
        return;
    }
    origDeminiaturize(self, _cmd, sender);
}

// After launch the main window is not shown; it counts as
// minimized, so the menu's Open (deminiaturize:) brings it up. Ghosting it for
// a camera request is still allowed.
static BOOL ghosted;

static BOOL fsaux_keepHidden(NSWindow *w) {
    if (!keepMainHidden || ghosted || !fsaux_isMainWindow(w)) return NO;
    if (hiddenWindow != w) { hiddenWindow = w; fsaux_log(w, @"launch: main window kept hidden"); }
    return YES;
}

static void *swizzle(Class c, SEL sel, void *imp) {
    return (void *)method_setImplementation(class_getInstanceMethod(c, sel), (IMP)imp);
}

// --- 4. JavaScript injection into the app's WebViews ---
// Contents/Resources/fsaux-inject.js is added as a user script to every
// WKWebView. JS talks back via window.webkit.messageHandlers.fsaux.postMessage
// ({cmd: 'log', msg} | {cmd: 'state', running} | {cmd: 'ghost', on} | {cmd: 'menu', item} |
//  {cmd: 'windows'} | {cmd: 'write', name, data} | {cmd: 'screentime'}).

static NSHashTable<WKWebView *> *webViews;  // weak
static BOOL monitoringRunning;
static id fsaux_menuTarget(void);
static void fsaux_sendScreenTime(void);
static void fsaux_sendScreenState(void);
static void fsaux_setAutostart(BOOL on);
static void fsaux_sendAutostart(void);

// WebKit only grants camera requests while the page's window is on screen.
// When the hidden main window needs the camera, show it fully transparent,
// click-through and without activating the app, until the request finishes.
static int ghostCount;
static BOOL ghostWasMinimized;  // window was hidden by minimize (hiddenWindow)

static void fsaux_unghost(NSWindow *w) {
    ghosted = NO;
    ghostWasMinimized = NO;
    ghostCount = 0;
    w.alphaValue = 1;
    w.ignoresMouseEvents = NO;
}

static void fsaux_ghost(NSWindow *w, BOOL on) {
    if (!w) return;
    if (on) {
        if (++ghostCount > 1 || w.isVisible) return;
        fsaux_log(w, @"ghost show (camera request while hidden)");
        ghosted = YES;
        // Otherwise AppKit treats ordering it front as un-minimizing, which
        // would activate the app via the deminiaturize: hook.
        ghostWasMinimized = (w == hiddenWindow);
        hiddenWindow = nil;
        w.alphaValue = 0;
        w.ignoresMouseEvents = YES;
        [w orderFrontRegardless];
        // Safety net in case a request never finishes.
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            if (ghosted) { ghostCount = 1; fsaux_ghost(w, NO); }
        });
    } else {
        if (ghostCount > 0) ghostCount--;
        if (ghostCount > 0 || !ghosted) return;
        fsaux_log(w, @"ghost hide");
        origOrderOut(w, @selector(orderOut:), nil);
        if (ghostWasMinimized) hiddenWindow = w;
        fsaux_unghost(w);
    }
}

@interface FsauxBridge : NSObject <WKScriptMessageHandler>
@end

@implementation FsauxBridge
- (void)userContentController:(WKUserContentController *)ucc didReceiveScriptMessage:(WKScriptMessage *)m {
    NSDictionary *d = [m.body isKindOfClass:[NSDictionary class]] ? m.body : @{};
    NSString *cmd = d[@"cmd"];
    if ([cmd isEqual:@"log"]) {
        fsaux_log(m.webView.window, [NSString stringWithFormat:@"JS %@", d[@"msg"]]);
    } else if ([cmd isEqual:@"state"]) {
        monitoringRunning = [d[@"running"] boolValue];
        if ([d[@"lang"] isKindOfClass:[NSString class]]) uiLang = d[@"lang"];
        fsaux_log(m.webView.window, monitoringRunning ? @"state running" : @"state stopped");
    } else if ([cmd isEqual:@"ghost"]) {
        fsaux_ghost(m.webView.window, [d[@"on"] boolValue]);
    } else if ([cmd isEqual:@"menu"]) {
        // Debug: trigger a menu item without clicking ({cmd: 'menu', item: 'stop'}).
        SEL sel = NSSelectorFromString([d[@"item"] stringByAppendingString:@":"]);
        id t = fsaux_menuTarget();
        if ([t respondsToSelector:sel]) ((void (*)(id, SEL, id))objc_msgSend)(t, sel, nil);
    } else if ([cmd isEqual:@"screentime"]) {
        // The JS asks when it starts and when the statistics panel opens.
        fsaux_sendScreenTime();
        fsaux_sendScreenState();
    } else if ([cmd isEqual:@"autostart"]) {
        // {cmd: 'autostart'} reports the state, {cmd: 'autostart', on} changes it.
        if (d[@"on"]) fsaux_setAutostart([d[@"on"] boolValue]);
        fsaux_sendAutostart();
    } else if ([cmd isEqual:@"windows"]) {
        for (NSWindow *w in NSApp.windows) {
            fsaux_log(w, w.isVisible ? @"window (visible)" : @"window (hidden)");
            NSMutableArray *stack = [NSMutableArray arrayWithObject:@[w.contentView ?: [NSNull null], @0]];
            while (stack.count) {
                NSArray *e = stack.lastObject; [stack removeLastObject];
                if (e[0] == [NSNull null]) continue;
                NSView *v = e[0]; int d = [e[1] intValue];
                fsaux_log(w, [NSString stringWithFormat:@"  view %*s%@ %@", d * 2, "", NSStringFromClass([v class]), NSStringFromRect(v.frame)]);
                if (d < 6) for (NSView *c in v.subviews.reverseObjectEnumerator) [stack addObject:@[c, @(d + 1)]];
            }
        }
    } else if ([cmd isEqual:@"write"]) {
        NSString *dir = [NSTemporaryDirectory() stringByAppendingPathComponent:@"fsaux-dump"];
        [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
        NSString *name = [[d[@"name"] description] lastPathComponent];
        [[d[@"data"] description] writeToFile:[dir stringByAppendingPathComponent:name] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    }
}
@end

static id (*origWebViewInit)(id, SEL, NSRect, WKWebViewConfiguration *);

static id hookWebViewInit(WKWebView *self, SEL _cmd, NSRect frame, WKWebViewConfiguration *cfg) {
    static FsauxBridge *bridge;
    if (!bridge) bridge = [FsauxBridge new];
    NSString *path = [[NSBundle mainBundle] pathForResource:@"fsaux-inject" ofType:@"js"];
    NSString *js = path ? [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil] : nil;
    if (js) {
        WKUserContentController *ucc = cfg.userContentController;
        @try { [ucc addScriptMessageHandler:bridge name:@"fsaux"]; } @catch (NSException *e) {}
        [ucc addUserScript:[[WKUserScript alloc] initWithSource:js
            injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    }
    id wv = origWebViewInit(self, _cmd, frame, cfg);
    if (!webViews) webViews = [NSHashTable weakObjectsHashTable];
    if (wv) [webViews addObject:wv];
    return wv;
}

// --- 7. usage statistics ---
// Screen-on seconds per local day, from the "Display is turned on/off" (and
// sleep) entries of `pmset -g log`. macOS keeps about a week of that log, so the
// JS stores each day it receives. Days before the log's first entry are left
// out, and the first one is partial.

static NSDictionary *fsaux_screenTimeFromLog(NSString *log) {
    static NSRegularExpression *re;
    if (!re) re = [NSRegularExpression regularExpressionWithPattern:
        @"^(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d [+-]\\d{4}) +(?:Notification +\\tDisplay is turned (on|off)|(Sleep) +\\t)"
        options:NSRegularExpressionAnchorsMatchLines error:nil];
    NSDateFormatter *fmt = [NSDateFormatter new];
    fmt.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    fmt.dateFormat = @"yyyy-MM-dd HH:mm:ss Z";
    NSDateFormatter *dayFmt = [NSDateFormatter new];
    dayFmt.locale = fmt.locale;
    dayFmt.dateFormat = @"yyyy-MM-dd";
    NSCalendar *cal = [NSCalendar currentCalendar];
    NSMutableDictionary<NSString *, NSNumber *> *days = [NSMutableDictionary dictionary];

    __block NSDate *onSince = nil, *first = nil;
    void (^addRange)(NSDate *, NSDate *) = ^(NSDate *a, NSDate *b) {
        while ([a compare:b] == NSOrderedAscending) {
            NSDate *next = [cal startOfDayForDate:[cal dateByAddingUnit:NSCalendarUnitDay value:1 toDate:a options:0]];
            NSDate *end = [next compare:b] == NSOrderedAscending ? next : b;
            NSString *k = [dayFmt stringFromDate:a];
            days[k] = @(days[k].doubleValue + [end timeIntervalSinceDate:a]);
            a = end;
        }
    };
    for (NSTextCheckingResult *m in [re matchesInString:log options:0 range:NSMakeRange(0, log.length)]) {
        NSDate *t = [fmt dateFromString:[log substringWithRange:[m rangeAtIndex:1]]];
        if (!t) continue;
        if (!first) first = t;
        BOOL on = [m rangeAtIndex:2].location != NSNotFound && [[log substringWithRange:[m rangeAtIndex:2]] isEqual:@"on"];
        if (on) { if (!onSince) onSince = t; }
        else if (onSince) { addRange(onSince, t); onSince = nil; }
    }
    if (onSince) addRange(onSince, [NSDate date]);
    if (!first) return nil;
    return @{@"first": [dayFmt stringFromDate:first], @"days": days};
}

static void fsaux_sendScreenTime(void) {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSTask *task = [NSTask new];
        task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/pmset"];
        task.arguments = @[@"-g", @"log"];
        NSPipe *pipe = [NSPipe pipe];
        task.standardOutput = pipe;
        task.standardError = [NSFileHandle fileHandleWithNullDevice];
        NSError *err;
        if (![task launchAndReturnError:&err]) {
            dispatch_async(dispatch_get_main_queue(), ^{ fsaux_log(nil, [NSString stringWithFormat:@"pmset failed: %@", err]); });
            return;
        }
        NSData *data = [pipe.fileHandleForReading readDataToEndOfFile];
        [task waitUntilExit];
        NSString *log = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"";
        NSDictionary *st = fsaux_screenTimeFromLog(log);
        dispatch_async(dispatch_get_main_queue(), ^{
            fsaux_log(nil, [NSString stringWithFormat:@"screen time: %lu bytes of log, %lu days from %@",
                (unsigned long)data.length, (unsigned long)[st[@"days"] count], st[@"first"]]);
            if (!st) return;
            NSData *json = [NSJSONSerialization dataWithJSONObject:st options:0 error:nil];
            fsaux_runJS([NSString stringWithFormat:@"window.__fsaux && window.__fsaux.screenTime(%@)",
                [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]]);
        });
    });
}

// Screen asleep or the session locked: tracking time stops counting.
static BOOL screenAsleep, sessionLocked;

static void fsaux_sendScreenState(void) {
    fsaux_runJS([NSString stringWithFormat:@"window.__fsaux && window.__fsaux.screenOn(%@)",
        (screenAsleep || sessionLocked) ? @"false" : @"true"]);
}

static void fsaux_observeScreenState(void) {
    NSNotificationCenter *wc = [[NSWorkspace sharedWorkspace] notificationCenter];
    [wc addObserverForName:NSWorkspaceScreensDidSleepNotification object:nil queue:nil usingBlock:^(NSNotification *n) {
        screenAsleep = YES; fsaux_sendScreenState();
    }];
    [wc addObserverForName:NSWorkspaceScreensDidWakeNotification object:nil queue:nil usingBlock:^(NSNotification *n) {
        screenAsleep = NO; fsaux_sendScreenState();
    }];
    NSDistributedNotificationCenter *dc = [NSDistributedNotificationCenter defaultCenter];
    [dc addObserverForName:@"com.apple.screenIsLocked" object:nil queue:nil usingBlock:^(NSNotification *n) {
        sessionLocked = YES; fsaux_sendScreenState();
    }];
    [dc addObserverForName:@"com.apple.screenIsUnlocked" object:nil queue:nil usingBlock:^(NSNotification *n) {
        sessionLocked = NO; fsaux_sendScreenState();
    }];
}

// --- 8. run at startup ---
// Contents/Library/LaunchAgents/<kAgentPlist> (added by patch.sh) runs the
// app's binary with --fsaux-autostart at login. The app's own autostart
// (osascript / ~/Library/LaunchAgents) can't work inside the sandbox.

static NSString *const kAgentPlist = @"com.vinlemon.eyeREST.fsaux-autostart.plist";

static SMAppService *fsaux_agent(void) API_AVAILABLE(macos(13.0)) {
    return [SMAppService agentServiceWithPlistName:kAgentPlist];
}

static void fsaux_setAutostart(BOOL on) {
    if (@available(macOS 13.0, *)) {
        NSError *err;
        BOOL ok = on ? [fsaux_agent() registerAndReturnError:&err] : [fsaux_agent() unregisterAndReturnError:&err];
        fsaux_log(nil, [NSString stringWithFormat:@"autostart %@: %@ %@", on ? @"on" : @"off", ok ? @"ok" : @"failed", err ?: @""]);
    }
}

static void fsaux_sendAutostart(void) {
    NSString *state = @"unsupported";
    if (@available(macOS 13.0, *)) {
        switch (fsaux_agent().status) {
            case SMAppServiceStatusEnabled: state = @"on"; break;
            case SMAppServiceStatusRequiresApproval: state = @"approval"; break;
            default: state = @"off";
        }
    }
    fsaux_runJS([NSString stringWithFormat:@"window.__fsaux && window.__fsaux.autostartState('%@')", state]);
}

// Registering the agent also runs it right away, and the app may be opened
// while it already runs: a second copy quits before it shows anything.
static void fsaux_quitIfDuplicate(void) {
    NSString *bid = [NSBundle mainBundle].bundleIdentifier;
    for (NSRunningApplication *a in [NSRunningApplication runningApplicationsWithBundleIdentifier:bid]) {
        if (a.processIdentifier != getpid() && !a.terminated) {
            fsaux_log(nil, [NSString stringWithFormat:@"already running (pid %d), quitting", a.processIdentifier]);
            exit(0);
        }
    }
}

// --- 5. menu-bar icon menu: Open / Start / Stop / Exit ---
// The icon is a TaoTrayTarget view (created by the tray-icon crate) inside the
// NSStatusBarButton; its clicks normally just show the window. Replace them
// with a menu.

static NSWindow *fsaux_mainWindow(void) {
    for (NSWindow *w in NSApp.windows) if (fsaux_isMainWindow(w)) return w;
    return nil;
}

static void fsaux_runJS(NSString *js) {
    NSWindow *main = fsaux_mainWindow();
    for (WKWebView *wv in webViews) {
        if (wv.window == main) [wv evaluateJavaScript:js completionHandler:nil];
    }
}

@interface FsauxMenu : NSObject <NSMenuItemValidation>
@end

@implementation FsauxMenu
- (void)open:(id)sender {
    NSWindow *w = fsaux_mainWindow();
    if (!w) return;
    hiddenWindow = nil;
    keepMainHidden = NO;
    fsaux_unghost(w);
    if (origIsMiniaturized(w, @selector(isMiniaturized))) origDeminiaturize(w, @selector(deminiaturize:), nil);
    [NSApp activateIgnoringOtherApps:YES];
    [w makeKeyAndOrderFront:nil];
}
- (void)start:(id)sender { fsaux_runJS(@"window.__fsaux && window.__fsaux.start()"); }
- (void)stop:(id)sender { fsaux_runJS(@"window.__fsaux && window.__fsaux.stop()"); }
- (void)exit:(id)sender { fsaux_confirmQuit(fsaux_mainWindow(), @"menu exit->quit"); }
- (BOOL)validateMenuItem:(NSMenuItem *)item {
    if (item.action == @selector(start:)) return !monitoringRunning;
    if (item.action == @selector(stop:)) return monitoringRunning;
    return YES;
}
@end

static id fsaux_menuTarget(void) {
    static FsauxMenu *target;
    if (!target) target = [FsauxMenu new];
    return target;
}

static void fsaux_showTrayMenu(NSView *view) {
    static NSMenu *menu;
    if (!menu) {
        id target = fsaux_menuTarget();
        menu = [[NSMenu alloc] initWithTitle:@"eyeREST"];
        for (NSArray *e in @[@[@"Open", @"open:"], @[@"Start", @"start:"], @[@"Stop", @"stop:"],
                             @[@"-", @""], @[@"Exit", @"exit:"]]) {
            if ([e[0] isEqual:@"-"]) { [menu addItem:[NSMenuItem separatorItem]]; continue; }
            NSMenuItem *i = [menu addItemWithTitle:e[0] action:NSSelectorFromString(e[1]) keyEquivalent:@""];
            i.target = target;
        }
    }
    NSView *button = view.superview ?: view;
    [menu popUpMenuPositioningItem:nil atLocation:NSMakePoint(0, -4) inView:button];
}

static void trayMouseDown(NSView *self, SEL _cmd, NSEvent *e) { fsaux_showTrayMenu(self); }
static void trayIgnore(NSView *self, SEL _cmd, NSEvent *e) {}

// Opening the app again while it runs (Finder, Spotlight, Launchpad) shows
// the main window. Added to tao's app delegate once it exists.
static BOOL (*origShouldReopen)(id, SEL, NSApplication *, BOOL);

static BOOL hookShouldReopen(id self, SEL _cmd, NSApplication *app, BOOL visible) {
    fsaux_log(nil, @"reopen -> open main window");
    [fsaux_menuTarget() open:nil];
    return origShouldReopen ? origShouldReopen(self, _cmd, app, visible) : NO;
}

static void fsaux_hookReopenWhenReady(void) {
    id delegate = NSApp.delegate;
    if (!delegate) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 200 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ fsaux_hookReopenWhenReady(); });
        return;
    }
    SEL sel = @selector(applicationShouldHandleReopen:hasVisibleWindows:);
    Class c = [delegate class];
    Method m = class_getInstanceMethod(c, sel);
    if (m) origShouldReopen = (void *)method_setImplementation(m, (IMP)hookShouldReopen);
    else class_addMethod(c, sel, (IMP)hookShouldReopen, "c@:@c");
}

static void fsaux_hookTrayWhenReady(void) {
    Class c = objc_getClass("TaoTrayTarget");
    if (!c) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 200 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ fsaux_hookTrayWhenReady(); });
        return;
    }
    const char *types = method_getTypeEncoding(class_getInstanceMethod([NSView class], @selector(mouseDown:)));
    // class_replaceMethod only touches TaoTrayTarget, never NSView itself.
    class_replaceMethod(c, @selector(mouseDown:), (IMP)trayMouseDown, types);
    class_replaceMethod(c, @selector(rightMouseDown:), (IMP)trayMouseDown, types);
    class_replaceMethod(c, @selector(mouseUp:), (IMP)trayIgnore, types);
    class_replaceMethod(c, @selector(rightMouseUp:), (IMP)trayIgnore, types);
    fsaux_log(nil, @"tray menu installed");
}

__attribute__((constructor)) static void fsaux_init(void) {
    fsaux_quitIfDuplicate();
    if ([[NSProcessInfo processInfo].arguments containsObject:@"--fsaux-autostart"]) fsaux_log(nil, @"started by login item");
    fsaux_observeMainWindowFocus();
    fsaux_observeScreenChanges();
    fsaux_observeScreenState();
    dispatch_async(dispatch_get_main_queue(), ^{ fsaux_hookTrayWhenReady(); fsaux_hookReopenWhenReady(); });
    origWebViewInit = swizzle([WKWebView class], @selector(initWithFrame:configuration:), hookWebViewInit);
    Class w = [NSWindow class];
    origSetPolicy = swizzle([NSApplication class], @selector(setActivationPolicy:), hookSetPolicy);
    origSetLevel = swizzle(w, @selector(setLevel:), hookSetLevel);
    origSetCB = swizzle(w, @selector(setCollectionBehavior:), hookSetCB);
    origPerformClose = swizzle(w, @selector(performClose:), hookPerformClose);
    origClose = swizzle(w, @selector(close), hookClose);
    origOrderOut = swizzle(w, @selector(orderOut:), hookOrderOut);
    origMiniaturize = swizzle(w, @selector(miniaturize:), hookMiniaturize);
    origPerformMiniaturize = swizzle(w, @selector(performMiniaturize:), hookPerformMiniaturize);
    origDeminiaturize = swizzle(w, @selector(deminiaturize:), hookDeminiaturize);
    origIsMiniaturized = swizzle(w, @selector(isMiniaturized), hookIsMiniaturized);
    origOrderWindow = swizzle(w, @selector(orderWindow:relativeTo:), hookOrderWindow);
    origOrderFrontRegardless = swizzle(w, @selector(orderFrontRegardless), hookOrderFrontRegardless);
}
