// agent-platform Windows 客户端（原生 WinForms，零外部依赖）
//  - 双击即用：未安装 → 一键安装向导（复制载荷 + 写注册表卸载项 + 快捷方式）
//  - 已安装 → 托盘常驻 + 主窗口（WebView2 内嵌 Web UI；不可用则回退浏览器打开）
//  - 内核管理：自动探测 Node、拉起 scripts/serve.js、捕获令牌 URL、崩溃自动重启 ×3
//  - C# 5 语法（系统 csc 可编译）；WebView2 仅在 WEBVIEW2 定义时参与编译
//
// 编译：
//   csc /target:winexe /platform:x64 /out:agent-platform.exe /define:WEBVIEW2
//       /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Core.dll
//       /r:webview2\Microsoft.Web.WebView2.Core.dll /r:webview2\Microsoft.Web.WebView2.WinForms.dll
//       client.cs

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace AgentPlatform
{
    internal static class Program
    {
        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        /// <summary>窗体暗色标题栏（Win10 20H1+/Win11，DWMWA_USE_IMMERSIVE_DARK_MODE）</summary>
        internal static void ApplyDarkTitlebar(Form f)
        {
            try
            {
                int on = 1;
                if (DwmSetWindowAttribute(f.Handle, 20, ref on, 4) != 0)
                {
                    DwmSetWindowAttribute(f.Handle, 19, ref on, 4);
                }
            }
            catch { }
        }

        [DllImport("user32.dll")]
        internal static extern void ReleaseCapture();

        [DllImport("user32.dll")]
        internal static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        internal static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        internal static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll")]
        internal static extern bool SetForegroundWindow(IntPtr hWnd);

        internal const int WM_NCLBUTTONDOWN = 0xA1;
        internal const int HTCAPTION = 0x2;
        internal const uint MOD_CONTROL = 0x2;
        internal const uint MOD_ALT = 0x1;
        internal const uint MOD_NOREPEAT = 0x4000;

        /** 活跃 WebView2 实例（object 持有，WEBVIEW2 构建内转型使用） */
        internal static object ActiveWv;

        /** JS → 宿主消息（会话标题等） */
        internal static Action<string> WebMessageSink;

        /** 后台回合完成通知（turn-done → 托盘气泡，仅窗体不可见时） */
        internal static Action<string> NotifySink;

        /** JS → 宿主消息（会话标题等） */
        internal static Action<string> WebMessageSink;

        [STAThread]
        private static void Main(string[] args)
        {
            bool hasFlag = false;
            for (int i = 0; i < args.Length; i++)
            {
                if (string.Equals(args[i], "--uninstall", StringComparison.OrdinalIgnoreCase)) hasFlag = true;
            }
            if (hasFlag) { Uninstaller.Run(); return; }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            ClientController client = new ClientController();
            client.Run(args);
        }
    }

    internal sealed class ClientController : ApplicationContext
    {
        private const string RegKey = "Software\\AgentPlatform";
        private static readonly Regex UrlRx = new Regex(
            @"http://127\.0\.0\.1:\d+/\?token=[0-9a-fA-F]+", RegexOptions.Compiled);

        private NotifyIcon _tray;
        private MainForm _form;
        private Process _kernel;
        private string _kernelUrl;
        private string _installDir;
        private string _nodePath;
        private bool _stopping;
        private int _restarts;
        private System.Windows.Forms.Timer _restartTimer;

        public ClientController()
        {
        }

        public void Run(string[] args)
        {
            bool created;
            Mutex mutex = new Mutex(true, "Local\\AgentPlatformClient", out created);
            if (!created)
            {
                MessageBox.Show("agent-platform 已在运行（托盘图标）。", "agent-platform",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            // WebView2 程序集在包内 webview2\ 子目录 → 注册解析器（否则 CLR 只找 exe 根目录）
            AppDomain.CurrentDomain.AssemblyResolve += delegate(object s, ResolveEventArgs e2)
            {
                string n = e2.Name;
                if (n == null || n.IndexOf("Microsoft.Web.WebView2", StringComparison.OrdinalIgnoreCase) < 0) return null;
                string simple = n.Split(new[] { ',' })[0];
                string[] probes = new string[]
                {
                    Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "webview2", simple + ".dll"),
                    Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "client", "webview2", simple + ".dll")
                };
                for (int i = 0; i < probes.Length; i++)
                {
                    if (File.Exists(probes[i])) return System.Reflection.Assembly.LoadFrom(probes[i]);
                }
                return null;
            };

            // ---- 解析安装目录：注册表 → 便携模式（exe 旁有 scripts/serve.js）→ 安装向导 ----
            _installDir = ReadInstallDirFromRegistry();
            if (_installDir == null && File.Exists(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "scripts", "serve.js")))
            {
                _installDir = AppDomain.CurrentDomain.BaseDirectory; // 便携/开发模式
            }
            if (_installDir == null)
            {
                SetupWizard wizard = new SetupWizard();
                if (wizard.ShowDialog() != DialogResult.OK)
                {
                    return; // 用户取消安装
                }
                _installDir = wizard.InstalledDir;
            }

            _nodePath = FindNode();
            if (_nodePath == null)
            {
                MessageBox.Show("未找到 Node.js（需要 >= 22.6）。请安装 Node 后重试。",
                    "agent-platform", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            Application.ThreadException += OnThreadException;
            Log("客户端启动（installDir=" + _installDir + "，node=" + _nodePath + "）");

            CreateTray();
            _form = new MainForm(this);
            _form.Show();

            StartKernel();
            Application.Run(this);
        }

        private static void OnThreadException(object sender, ThreadExceptionEventArgs e)
        {
            Log("UI 异常: " + e.Exception.Message);
        }

        // ================= 内核管理 =================

        public void StartKernel()
        {
            if (_kernel != null && !_kernel.HasExited) return;

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = _nodePath;
            psi.Arguments = "--experimental-strip-types --no-warnings --experimental-sqlite \"scripts\\serve.js\"";
            psi.WorkingDirectory = _installDir;
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            // 内核 stdout/stderr 是 UTF-8；不显式指定会被当 GBK 解码，全角标点吞掉 URL 首字母
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            string baseUrl = ReadConfigBaseUrl();
            if (baseUrl != null) psi.EnvironmentVariables["MYAGENT_BASE_URL"] = baseUrl;

            try
            {
                _kernel = Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show("内核启动失败：" + ex.Message, "agent-platform",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            _kernel.OutputDataReceived += OnKernelStdout;
            _kernel.ErrorDataReceived += OnKernelStderr;
            _kernel.BeginOutputReadLine();
            _kernel.BeginErrorReadLine();
            _kernel.Exited += OnKernelExited;
            _kernel.EnableRaisingEvents = true;
            Log("内核已启动 pid=" + _kernel.Id);
        }

        public void RestartKernel()
        {
            StopKernel();
            Thread.Sleep(300);
            StartKernel();
        }

        public void ExitApp()
        {
            _stopping = true;
            StopKernel();
            if (_tray != null) _tray.Visible = false;
            Application.Exit();
        }

        private void StopKernel()
        {
            if (_kernel != null && !_kernel.HasExited)
            {
                try { _kernel.Kill(); } catch { }
            }
            _kernel = null;
        }

        private void OnKernelStdout(object sender, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            Log("[kernel] " + e.Data);
            Match m = UrlRx.Match(e.Data);
            if (m.Success)
            {
                _kernelUrl = m.Value;
                UiPost(delegate
                {
                    try { OnKernelUrlReady(_kernelUrl); }
                    catch (Exception ex) { Log("URL 就绪处理异常: " + ex.Message); }
                });
            }
        }

        /// <summary>把动作投递到 UI 线程；窗体未就绪时直接在线程池执行（都兜 try）</summary>
        private void UiPost(Action action)
        {
            try
            {
                if (_form != null && _form.IsHandleCreated)
                {
                    _form.BeginInvoke(action);
                    return;
                }
            }
            catch { }
            try { action(); } catch (Exception ex) { Log("UiPost 直接执行异常: " + ex.Message); }
        }

        private void OnKernelStderr(object sender, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            Log("[kernel:err] " + e.Data);
        }

        private void OnKernelExited(object sender, EventArgs e)
        {
            UiPost(delegate
            {
                if (_stopping) return;
                _restarts++;
                if (_restarts > 3)
                {
                    _tray.ShowBalloonTip(5000, "agent-platform", "内核连续崩溃超过 3 次，已停止。请查看 data\\client.log", ToolTipIcon.Error);
                    return;
                }
                _tray.ShowBalloonTip(3000, "agent-platform", "内核退出，2 秒后自动重启（" + _restarts + "/3）", ToolTipIcon.Warning);
                if (_restartTimer == null)
                {
                    _restartTimer = new System.Windows.Forms.Timer();
                    _restartTimer.Interval = 2000;
                    _restartTimer.Tick += delegate
                    {
                        _restartTimer.Stop();
                        StartKernel();
                    };
                }
                _restartTimer.Start();
            });
        }

        private void OnKernelUrlReady(string url)
        {
            Log("URL 就绪回调: " + url);
            if (_form != null && !_form.IsDisposed) _form.LoadInto(url);
            _tray.ShowBalloonTip(3000, "agent-platform", "已就绪：" + url, ToolTipIcon.Info);
        }

        public string KernelUrl
        {
            get { return _kernelUrl; }
        }

        // ================= 主窗口承载 =================

        public void LoadInto(MainForm form) // 供重启后重新导航
        {
            if (_kernelUrl != null) form.LoadInto(_kernelUrl);
        }

        public void BeginEmbedWebView2(Control host, string url, Action<bool> done)
        {
#if WEBVIEW2
            Log("尝试内嵌 WebView2…");
            WebView2Host.BeginEmbed(host, url, Path.Combine(_installDir, "data", "webview2-profile"), done);
#else
            done(false);
#endif
        }

        // ================= 托盘 =================

        private void CreateTray()
        {
            _tray = new NotifyIcon();
            _tray.Icon = LoadAppIcon();
            _tray.Text = "BugKiller";
            _tray.Visible = true;

            // 后台回合完成 → 托盘气泡（窗体隐藏/最小化时才打扰）
            Program.NotifySink = delegate(string json)
            {
                try
                {
                    bool away = _form == null || !_form.Visible || _form.WindowState == FormWindowState.Minimized;
                    if (away && json != null && json.IndexOf("turn-done", StringComparison.Ordinal) >= 0)
                    {
                        _tray.ShowBalloonTip(2500, "BugKiller", "回合已完成 —— 点托盘图标查看结果", ToolTipIcon.Info);
                    }
                }
                catch { }
            };

            ContextMenu menu = new ContextMenu();
            MenuItem miOpen = new MenuItem("打开主窗口");
            miOpen.Click += delegate { ShowMain(); };
            MenuItem miRestart = new MenuItem("重启内核");
            miRestart.Click += delegate { RestartKernel(); };
            MenuItem miExit = new MenuItem("退出");
            miExit.Click += delegate { ExitApp(); };
            menu.MenuItems.Add(miOpen);
            menu.MenuItems.Add(miRestart);
            menu.MenuItems.Add(new MenuItem("-"));
            menu.MenuItems.Add(miExit);
            _tray.ContextMenu = menu;
            _tray.DoubleClick += delegate { ShowMain(); };
        }

        public void ShowMain()
        {
            if (_form == null || _form.IsDisposed) _form = new MainForm(this);
            _form.Show();
            _form.WindowState = FormWindowState.Normal;
            _form.Activate();
        }

        /// <summary>应用图标：取 exe 内嵌图标（csc /win32icon 注入），任务栏/托盘/窗口统一</summary>
        public static Icon LoadAppIcon()
        {
            try
            {
                Icon ic = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (ic != null) return ic;
            }
            catch { }
            return SystemIcons.Application;
        }

        // ================= 探测 / 配置 =================

        private string ReadInstallDirFromRegistry()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RegKey))
                {
                    if (k == null) return null;
                    object v = k.GetValue("InstallDir");
                    string dir = v as string;
                    if (dir != null && Directory.Exists(Path.Combine(dir, "scripts", "serve.js"))) return dir;
                }
            }
            catch { }
            return null;
        }

        private string FindNode()
        {
            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            string[] dirs = pathEnv.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < dirs.Length; i++)
            {
                string cand = Path.Combine(dirs[i].Trim(), "node.exe");
                if (File.Exists(cand)) return cand;
            }
            // 兜底：智作平台自带的 Node 运行时
            try
            {
                string root = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    ".stratex", "runtimes", "node", "versions");
                if (Directory.Exists(root))
                {
                    string[] vers = Directory.GetDirectories(root);
                    Array.Sort(vers);
                    for (int i = vers.Length - 1; i >= 0; i--)
                    {
                        string cand = Path.Combine(vers[i], "node.exe");
                        if (File.Exists(cand)) return cand;
                    }
                }
            }
            catch { }
            return null;
        }

        private string ReadConfigBaseUrl()
        {
            try
            {
                string file = Path.Combine(_installDir, "data", "client-config.json");
                if (!File.Exists(file)) return null;
                string json = File.ReadAllText(file);
                Match m = Regex.Match(json, "\"baseUrl\"\\s*:\\s*\"([^\"]+)\"");
                return m.Success ? m.Groups[1].Value : null;
            }
            catch { return null; }
        }

        public static void Log(string line)
        {
            try
            {
                string dir = LogDir();
                if (dir == null) return;
                Directory.CreateDirectory(dir);
                File.AppendAllText(Path.Combine(dir, "client.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + line + Environment.NewLine);
            }
            catch { }
        }

        private static string LogDir()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RegKey))
                {
                    if (k != null)
                    {
                        object v = k.GetValue("InstallDir");
                        if (v != null) return Path.Combine((string)v, "data");
                    }
                }
            }
            catch { }
            // 便携/开发模式：日志落 exe 旁的 data\
            return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data");
        }
    }

    // ================= 主窗口 =================

    internal sealed class MainForm : Form
    {
        private readonly ClientController _owner;
        private Label _status;
        private Button _openBrowser;
        private bool _embedded;
        private Panel _caption;
        private Panel _content; // 标题栏之外的内容容器（WebView2/回退面板都住这里）
        private Label _capTitle;
        private Label _brandLabel;
        private Label _verLabel;
        private Button _btnMin;
        private Button _btnMax;
        private Button _btnClose;
        private const int CAP_H = 34;      // 自绘标题栏高度

        private const int WM_NCHITTEST = 0x84;
        private const int WM_HOTKEY = 0x0312;
        private const int HOTKEY_ID = 0xBEEF;

        public MainForm(ClientController owner)
        {
            _owner = owner;
            Program.WebMessageSink = delegate(string json)
            {
                try
                {
                    Match m = Regex.Match(json ?? "", "\"title\"\\s*:\\s*\"([^\"]+)\"");
                    if (m.Success) SetCaptionTitle(m.Groups[1].Value.Replace("\\u002B", "+"));
                }
                catch { }
            };
            Text = "BugKiller";
            Size = new Size(1280, 840);
            StartPosition = FormStartPosition.CenterScreen;
            Icon = ClientController.LoadAppIcon();
            FormBorderStyle = FormBorderStyle.None; // 一体化自绘标题栏

            // 手动布局（WebView2 是 HWND 宿主控件，Dock 叠放会被它盖住 → 标题栏与内容矩形必须不重叠）
            // 注意：窗口键字段由 BuildCaption 赋值并加入标题栏 —— 此处不得重复创建
            _caption = BuildCaption();
            _content = new Panel();
            _content.BackColor = Color.FromArgb(13, 14, 16);
            Controls.Add(_content);
            Controls.Add(_caption);
            _status = new Label();
            _status.Text = "正在启动内核…";
            _status.Dock = DockStyle.Fill;
            _status.TextAlign = ContentAlignment.MiddleCenter;
            _status.Font = new Font("Segoe UI", 11f);
            _content.Controls.Add(_status);
            LayoutChrome();

            FormClosing += delegate(object s, FormClosingEventArgs e)
            {
                if (e.CloseReason == CloseReason.UserClosing)
                {
                    e.Cancel = true;
                    Hide(); // 关窗即缩到托盘，内核保持运行
                }
            };
        }

        /** 手动布局：标题栏 34px 在顶，内容区紧随其下（与侧栏视觉连续）；标题栏内元素动态排布 */
        private void LayoutChrome()
        {
            int w = ClientSize.Width;
            int h = ClientSize.Height;
            if (_caption != null) _caption.SetBounds(0, 0, w, CAP_H);
            if (_content != null) _content.SetBounds(0, CAP_H, w, Math.Max(1, h - CAP_H));
            const int BW = 46;
            if (_btnClose != null) _btnClose.SetBounds(w - BW, 0, BW, CAP_H);
            if (_btnMax != null) _btnMax.SetBounds(w - BW * 2, 0, BW, CAP_H);
            if (_btnMin != null) _btnMin.SetBounds(w - BW * 3, 0, BW, CAP_H);
            // 标题栏内排布：品牌 → 版本（依次排开，互不重叠）
            if (_brandLabel != null && _verLabel != null)
            {
                _verLabel.Location = new Point(_brandLabel.Right + 10, 10);
            }
            ClientController.Log("[chrome] content=" + (_content != null ? _content.Bounds.ToString() : "null")
                + " | dock=" + (_content != null ? _content.Dock.ToString() : "?")
                + " | btnClose=" + (_btnClose != null ? _btnClose.Bounds.ToString() + "@" + (_btnClose.Parent != null ? _btnClose.Parent.GetType().Name : "null") + " dock=" + _btnClose.Dock : "null"));
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            LayoutChrome();
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            LayoutChrome();
        }

        private static Button CaptionButton(string txt, bool danger)
        {
            Button b = new Button();
            b.Text = txt;
            b.Size = new Size(46, 34);
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 0;
            b.BackColor = Color.FromArgb(18, 19, 22);   // 与顶栏同色
            b.ForeColor = Color.FromArgb(200, 204, 212);
            b.Font = new Font("Segoe MDL2 Assets", 11f);
            b.TextAlign = ContentAlignment.MiddleCenter;
            b.Cursor = Cursors.Hand;
            b.TabStop = false;
            Color hover = danger ? Color.FromArgb(196, 43, 28) : Color.FromArgb(70, 76, 86);
            b.MouseEnter += delegate { b.BackColor = hover; b.ForeColor = Color.White; };
            b.MouseLeave += delegate { b.BackColor = Color.FromArgb(18, 19, 22); b.ForeColor = Color.FromArgb(200, 204, 212); };
            return b;
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Program.ApplyDarkTitlebar(this);
            // 全局热键 Ctrl+Alt+B：任意界面唤起/隐藏主窗口（Alt+Space 被 Windows 系统菜单保留）
            try
            {
                bool ok = Program.RegisterHotKey(Handle, HOTKEY_ID, Program.MOD_CONTROL | Program.MOD_ALT | Program.MOD_NOREPEAT, 0x42);
                ClientController.Log("全局热键 Ctrl+Alt+B 注册: " + (ok ? "成功" : "失败（可能被其他程序占用）"));
            }
            catch { }
        }

        protected override void OnHandleDestroyed(EventArgs e)
        {
            try { Program.UnregisterHotKey(Handle, HOTKEY_ID); } catch { }
            base.OnHandleDestroyed(e);
        }

        /** 热键行为：隐藏 → 显示聚焦；最小化 → 还原聚焦；前台 → 藏到托盘 */
        private void ToggleFromHotkey()
        {
            if (!Visible)
            {
                Show();
                if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                Program.SetForegroundWindow(Handle);
                Activate();
            }
            else if (WindowState == FormWindowState.Minimized)
            {
                WindowState = FormWindowState.Normal;
                Program.SetForegroundWindow(Handle);
                Activate();
            }
            else
            {
                Hide(); // 前台 → 藏到托盘（内核保持运行）
            }
        }

        /// <summary>无边框窗口的边缘缩放（6px 热区）</summary>
        protected override void WndProc(ref Message m)
        {
            base.WndProc(ref m);
            if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == HOTKEY_ID) { ToggleFromHotkey(); return; }
            if (m.Msg == WM_NCHITTEST && (IntPtr)1 == m.Result && WindowState != FormWindowState.Maximized)
            {
                int lp = m.LParam.ToInt32();
                Point pos = PointToClient(new Point((short)(lp & 0xFFFF), (short)((lp >> 16) & 0xFFFF)));
                const int B = 6;
                bool l = pos.X <= B, r = pos.X >= Width - B, t = pos.Y <= B, b = pos.Y >= Height - B;
                if (l && t) m.Result = (IntPtr)13;       // HTTOPLEFT
                else if (r && t) m.Result = (IntPtr)14;  // HTTOPRIGHT
                else if (l && b) m.Result = (IntPtr)16;  // HTBOTTOMLEFT
                else if (r && b) m.Result = (IntPtr)17;  // HTBOTTOMRIGHT
                else if (l) m.Result = (IntPtr)10;       // HTLEFT
                else if (r) m.Result = (IntPtr)11;       // HTRIGHT
                else if (t) m.Result = (IntPtr)12;       // HTTOP
                else if (b) m.Result = (IntPtr)15;       // HTBOTTOM
            }
        }

        private void ToggleMaximize()
        {
            bool max = WindowState == FormWindowState.Maximized;
            WindowState = max ? FormWindowState.Normal : FormWindowState.Maximized;
            if (_btnMax != null) _btnMax.Text = max ? "\uE923" : "\uE922"; // 双框 ⇄ 单框
        }

        /// <summary>自绘标题栏（对照智作：品牌+版本+侧栏折叠+会话标题+窗口控制键）；bounds 由 LayoutChrome 管理</summary>
        private Panel BuildCaption()
        {
            Panel cap = new Panel();
            cap.BackColor = Color.FromArgb(18, 19, 22);

            Label brand = new Label();
            brand.Text = "  BugKiller";
            brand.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            brand.ForeColor = Color.FromArgb(220, 224, 232);
            brand.AutoSize = true;
            brand.Location = new Point(10, 8);
            brand.BackColor = Color.Transparent;
            cap.Controls.Add(brand);
            _brandLabel = brand;

            // 版本徽章（暗色小字，跟在品牌后）
            Label ver = new Label();
            ver.Text = "正式版 v0.1.0";
            ver.Font = new Font("Segoe UI", 8.5f);
            ver.ForeColor = Color.FromArgb(130, 135, 145);
            ver.AutoSize = true;
            ver.Location = new Point(126, 10);
            ver.BackColor = Color.Transparent;
            cap.Controls.Add(ver);
            _verLabel = ver;

            // 侧栏折叠键（对照智作 [|]）：通知 WebView2 折叠侧栏
            Button btnToggle = new Button();
            btnToggle.Text = "_Column";
            btnToggle.Font = new Font("Segoe UI Symbol", 9f);
            btnToggle.Size = new Size(26, 26);
            btnToggle.Location = new Point(52, 4);
            btnToggle.FlatStyle = FlatStyle.Flat;
            btnToggle.FlatAppearance.BorderSize = 0;
            btnToggle.BackColor = Color.FromArgb(18, 19, 22);
            btnToggle.ForeColor = Color.FromArgb(200, 204, 212);
            btnToggle.Cursor = Cursors.Hand;
            btnToggle.TabStop = false;
            btnToggle.Click += delegate
            {
#if WEBVIEW2
                try
                {
                    var wv = Program.ActiveWv as Microsoft.Web.WebView2.WinForms.WebView2;
                    if (wv != null && wv.CoreWebView2 != null)
                    {
                        wv.CoreWebView2.ExecuteScriptAsync(
                            "document.getElementById('app').classList.toggle('no-sidebar');void 0");
                    }
                }
                catch { }
#endif
            };
            cap.Controls.Add(btnToggle);

            // 会话标题不再重复显示（用户要求：左侧仅保留一个标题）；通道保留备用
            _capTitle = null;

            Action<Control> bindDrag = (c) =>
            {
                c.MouseDown += delegate(object s, MouseEventArgs e)
                {
                    if (e.Button == MouseButtons.Left)
                    {
                        Program.ReleaseCapture();
                        Program.SendMessage(Handle, Program.WM_NCLBUTTONDOWN, (IntPtr)Program.HTCAPTION, IntPtr.Zero);
                    }
                };
            };
            bindDrag(cap);
            bindDrag(brand);
            cap.MouseDoubleClick += delegate { ToggleMaximize(); };

            _btnMin = CaptionButton("\uE921", false);   // ─ 最小化
            _btnMax = CaptionButton("\uE923", false);   // ⧉ 双框（对照智作）；最大化后切 \uE922
            _btnClose = CaptionButton("\uE8BB", true);  // ✕ 关闭
            _btnMin.Click += delegate { WindowState = FormWindowState.Minimized; };
            _btnMax.Click += delegate { ToggleMaximize(); };
            _btnClose.Click += delegate { Close(); };
            cap.Controls.Add(_btnMin);   // 位置由 LayoutChrome 统一设置（右上角）
            cap.Controls.Add(_btnMax);
            cap.Controls.Add(_btnClose);
            return cap;
        }

        /// <summary>JS 会话标题上屏（WebView2 WebMessage）</summary>
        internal void SetCaptionTitle(string title)
        {
            if (_capTitle != null && !IsDisposed)
            {
                _capTitle.Text = string.IsNullOrEmpty(title) ? "agent-platform" : title;
            }
        }

        public void LoadInto(string url)
        {
            ClientController.Log("LoadInto: " + url);
            if (_embedded) return;
            _embedded = true; // 防重入；异步成败后再决定是否回退
            _owner.BeginEmbedWebView2(_content, url, delegate(bool ok)
            {
                // WebView2 会把 Chrome 窗口顶到 Z 序最上 → 嵌入完成后把标题栏提到最顶
                _caption.BringToFront();
                LayoutChrome(); // 重新断言布局
                ClientController.Log("[chrome] content=" + _content.Bounds.ToString() + " caption=" + _caption.Bounds.ToString());
                if (ok) return;
                ClientController.Log("内嵌不可用 → 浏览器回退模式");
                BuildFallback(url);
            });
            return;
        }

        private void BuildFallback(string url)
        {
            _embedded = true;
            // 回退：状态面板 + 浏览器打开（只清内容区，标题栏不动）
            _content.Controls.Clear();
            Panel p = new Panel();
            p.Dock = DockStyle.Fill;
            Label tip = new Label();
            tip.Text = "内核已就绪（未启用内嵌浏览器）";
            tip.AutoSize = true;
            tip.Location = new Point(24, 24);
            _openBrowser = new Button();
            _openBrowser.Text = "在浏览器中打开界面";
            _openBrowser.AutoSize = true;
            _openBrowser.Location = new Point(24, 64);
            _openBrowser.Click += delegate
            {
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo(url);
                    psi.UseShellExecute = true;
                    Process.Start(psi);
                }
                catch { }
            };
            p.Controls.Add(tip);
            p.Controls.Add(_openBrowser);
            _content.Controls.Add(p);
            _embedded = true; // 已按回退模式呈现
        }
    }

#if WEBVIEW2
    // ================= WebView2 内嵌（独立类型：仅在该方法被调用时才触发程序集加载） =================
    // 注意：EnsureCoreWebView2Async 的续延必须回 UI 线程 —— 在 UI 线程上 GetResult() 阻塞会死锁，
    // 必须用 async/await 让续延自然回到消息循环。
    internal static class WebView2Host
    {
        public static void BeginEmbed(Control host, string url, string userDataFolder, Action<bool> done)
        {
            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string loader = FindLoader(baseDir);
                if (loader == null || !RuntimePresent())
                {
                    ClientController.Log("WebView2 前置条件不满足（loader=" + (loader != null) + "）");
                    done(false);
                    return;
                }
                EmbedAsync(host, url, userDataFolder, done);
            }
            catch (Exception ex)
            {
                ClientController.Log("WebView2 启动异常: " + ex.Message);
                done(false);
            }
        }

        private static async void EmbedAsync(Control host, string url, string userDataFolder, Action<bool> done)
        {
            try
            {
                Microsoft.Web.WebView2.Core.CoreWebView2Environment env =
                    await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(null, userDataFolder);
                Microsoft.Web.WebView2.WinForms.WebView2 wv =
                    new Microsoft.Web.WebView2.WinForms.WebView2();
                wv.Dock = DockStyle.Fill;
                host.Controls.Clear();
                host.Controls.Add(wv);
                // 关键：HWND 宿主控件默认盖在普通控件之上 → 内容容器压到 Z 序底层，
                // 保证标题栏 Panel（普通控件）永远可见
                host.SendToBack();
                await wv.EnsureCoreWebView2Async(env);
                // JS → 宿主通道（会话标题上屏等）
                wv.CoreWebView2.WebMessageReceived += delegate(object s2, Microsoft.Web.WebView2.Core.CoreWebView2WebMessageReceivedEventArgs e2)
                {
                    try
                    {
                        string json = e2.WebMessageAsJson;
                        if (Program.WebMessageSink != null) Program.WebMessageSink(json);
                        if (Program.NotifySink != null) Program.NotifySink(json);
                    }
                    catch { }
                };
                Program.ActiveWv = wv;
                wv.Source = new Uri(url);
                ClientController.Log("WebView2 内嵌成功: " + url);
                done(true);
            }
            catch (Exception ex)
            {
                ClientController.Log("WebView2 内嵌失败: " + ex.Message);
                done(false);
            }
        }

        private static string FindLoader(string baseDir)
        {
            string[] candidates = new string[]
            {
                Path.Combine(baseDir, "webview2", "WebView2Loader.dll"),
                Path.Combine(baseDir, "client", "webview2", "WebView2Loader.dll")
            };
            for (int i = 0; i < candidates.Length; i++)
            {
                if (File.Exists(candidates[i])) return candidates[i];
            }
            return null;
        }

        private static bool RuntimePresent()
        {
            try
            {
                using (RegistryKey k = Registry.LocalMachine.OpenSubKey(
                    "SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"))
                {
                    if (k != null && k.GetValue("pv") != null) return true;
                }
            }
            catch { }
            return Directory.Exists("C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application");
        }
    }
#endif

    // ================= 安装向导 =================

    internal sealed class SetupWizard : Form
    {
        private TextBox _dir;
        private Label _log;
        private Button _go;
        public string InstalledDir;

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Program.ApplyDarkTitlebar(this);
        }

        public SetupWizard()
        {
            Text = "安装 agent-platform";
            Size = new Size(600, 280);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = false;
            Icon = ClientController.LoadAppIcon();
            BackColor = Color.FromArgb(20, 21, 24);

            Label tip = new Label();
            tip.Text = "将 agent-platform 安装到本机（当前用户），并在开始菜单创建快捷方式。";
            tip.AutoSize = true;
            tip.Location = new Point(18, 20);
            tip.ForeColor = Color.FromArgb(224, 227, 232);

            Label lbl = new Label();
            lbl.Text = "安装目录：";
            lbl.AutoSize = true;
            lbl.Location = new Point(18, 62);
            lbl.ForeColor = Color.FromArgb(150, 155, 164);

            _dir = new TextBox();
            _dir.Text = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "agent-platform");
            _dir.Width = 440;
            _dir.Location = new Point(100, 58);
            _dir.BackColor = Color.FromArgb(30, 32, 37);
            _dir.ForeColor = Color.FromArgb(224, 227, 232);
            _dir.BorderStyle = BorderStyle.FixedSingle;

            _go = new Button();
            _go.Text = "开始安装";
            _go.Location = new Point(100, 96);
            _go.Size = new Size(120, 30);
            _go.FlatStyle = FlatStyle.Flat;
            _go.BackColor = Color.FromArgb(79, 142, 247);
            _go.ForeColor = Color.White;
            _go.FlatAppearance.BorderSize = 0;
            _go.Cursor = Cursors.Hand;
            _go.Click += delegate { DoInstall(); };

            _log = new Label();
            _log.Text = "";
            _log.AutoSize = false;
            _log.Size = new Size(540, 70);
            _log.Location = new Point(18, 150);
            _log.ForeColor = Color.FromArgb(150, 155, 164);

            Controls.Add(tip);
            Controls.Add(lbl);
            Controls.Add(_dir);
            Controls.Add(_go);
            Controls.Add(_log);
        }

        private void Say(string s)
        {
            _log.Text = s;
            Application.DoEvents();
        }

        private void DoInstall()
        {
            try
            {
                string src = AppDomain.CurrentDomain.BaseDirectory;
                string dest = _dir.Text.Trim();
                if (!File.Exists(Path.Combine(src, "scripts", "serve.js")))
                {
                    Say("未在程序旁找到安装载荷（scripts/serve.js）。请从完整安装包运行。");
                    return;
                }
                Say("复制文件…");
                CopyPayload(src, dest);

                Say("写入注册表（卸载入口）…");
                WriteRegistry(dest);

                Say("创建快捷方式…");
                CreateShortcut(dest);

                Say("安装完成 ✔ " + dest);
                InstalledDir = dest;
                DialogResult = DialogResult.OK;
            }
            catch (Exception ex)
            {
                MessageBox.Show("安装失败：" + ex.Message, "agent-platform",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static void CopyPayload(string src, string dest)
        {
            Directory.CreateDirectory(dest);
            CopyDir(new DirectoryInfo(src), new DirectoryInfo(dest), true);
        }

        private static void CopyDir(DirectoryInfo src, DirectoryInfo dest, bool root)
        {
            if (!root)
            {
                string name = src.Name;
                if (name == "data" || name == "dist" || name == "keys" || name == ".git") return;
            }
            dest.Create();
            foreach (FileInfo f in src.GetFiles())
            {
                if (f.Name.EndsWith(".log")) continue;
                f.CopyTo(Path.Combine(dest.FullName, f.Name), true);
            }
            foreach (DirectoryInfo d in src.GetDirectories())
            {
                CopyDir(d, new DirectoryInfo(Path.Combine(dest.FullName, d.Name)), false);
            }
        }

        private static void WriteRegistry(string dest)
        {
            string version = "0.1.0";
            try
            {
                Match m = Regex.Match(
                    File.ReadAllText(Path.Combine(dest, "package.json")),
                    "\"version\"\\s*:\\s*\"([^\"]+)\"");
                if (m.Success) version = m.Groups[1].Value;
            }
            catch { }

            string exe = Path.Combine(dest, "agent-platform.exe");
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\agent-platform"))
            {
                k.SetValue("DisplayName", "agent-platform");
                k.SetValue("DisplayVersion", version);
                k.SetValue("UninstallString", "\"" + exe + "\" --uninstall");
                k.SetValue("DisplayIcon", exe);
                k.SetValue("InstallLocation", dest);
                k.SetValue("Publisher", "agent-platform");
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
            using (RegistryKey k2 = Registry.CurrentUser.CreateSubKey("Software\\AgentPlatform"))
            {
                k2.SetValue("InstallDir", dest);
            }
        }

        private static void CreateShortcut(string dest)
        {
            try
            {
                string exe = Path.Combine(dest, "agent-platform.exe");
                string lnk = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                    "agent-platform.lnk");
                string ps = "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('" +
                    lnk.Replace("'", "''") + "'); $sc.TargetPath = '" + exe.Replace("'", "''") +
                    "'; $sc.WorkingDirectory = '" + dest.Replace("'", "''") + "'; $sc.Save()";
                ProcessStartInfo psi = new ProcessStartInfo("powershell.exe");
                psi.Arguments = "-NoProfile -NonInteractive -Command \"" + ps.Replace("\"", "\\\"") + "\"";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                using (Process p = Process.Start(psi))
                {
                    p.WaitForExit(15000);
                }
            }
            catch { }
        }
    }

    // ================= 卸载 =================

    internal static class Uninstaller
    {
        public static void Run()
        {
            string dest = null;
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey("Software\\AgentPlatform"))
                {
                    if (k != null) dest = k.GetValue("InstallDir") as string;
                }
            }
            catch { }
            if (dest == null) dest = AppDomain.CurrentDomain.BaseDirectory;

            DialogResult dr = MessageBox.Show(
                "卸载 agent-platform？\n\n" + dest + "\n\n（会话与凭据等用户数据将被一并删除）",
                "卸载 agent-platform", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
            if (dr != DialogResult.OK) return;

            try
            {
                string lnk = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.Programs), "agent-platform.lnk");
                if (File.Exists(lnk)) File.Delete(lnk);
                Registry.CurrentUser.DeleteSubKeyTree("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\agent-platform", false);
                Registry.CurrentUser.DeleteSubKeyTree("Software\\AgentPlatform", false);
            }
            catch { }

            // 运行中的 exe 无法删除自己：交给延迟命令
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe");
                psi.Arguments = "/c ping -n 2 127.0.0.1 > nul & rmdir /s /q \"" + dest + "\"";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process.Start(psi);
            }
            catch { }

            MessageBox.Show("卸载完成。", "agent-platform", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }
}
