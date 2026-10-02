using System;
using System.Windows.Forms;
using System.Drawing;
using System.Runtime.InteropServices;

static class SeelenTestWindow
{
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode)] static extern bool WTSQuerySessionInformation(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
    [STAThread]
    static void Main(string[] args)
    {
        SetProcessDPIAware();
        if (args[0] == "desktop") {
            IntPtr buffer;
            int bytes;
            bool ready = false;
            // WTSINFOEXW: Level at 0, aligned Level1 data at 8;
            // SessionState at 12 (0=active), SessionFlags at 16 (1=unlocked).
            if (WTSQuerySessionInformation(IntPtr.Zero, -1, 25, out buffer, out bytes)) {
                ready = bytes >= 20 && Marshal.ReadInt32(buffer) == 1 &&
                    Marshal.ReadInt32(buffer, 12) == 0 && Marshal.ReadInt32(buffer, 16) == 1;
                WTSFreeMemory(buffer);
            }
            Environment.Exit(ready ? 0 : 2);
        }
        if (args[0] == "cursor") {
            if (!SetCursorPos(int.Parse(args[1]), int.Parse(args[2]))) {
                Console.Error.WriteLine("SetCursorPos failed: " + Marshal.GetLastWin32Error());
                Environment.Exit(3);
            }
            return;
        }
        if (args[0] == "bounds") {
            if (!SetWindowPos(new IntPtr(long.Parse(args[1])), IntPtr.Zero, int.Parse(args[2]), int.Parse(args[3]), int.Parse(args[4]), int.Parse(args[5]), 0x14)) Environment.Exit(3);
            return;
        }
        if (args[0] == "hit") {
            var hit = WindowFromPoint(new Point(int.Parse(args[1]), int.Parse(args[2])));
            Environment.Exit(GetAncestor(hit, 2).ToInt64() == long.Parse(args[3]) ? 0 : 4);
        }
        string title = args[0];
        int x = int.Parse(args[1]), y = int.Parse(args[2]), count = int.Parse(args[3]);
        var forms = new Form[count];
        for (int i = 0; i < count; i++)
        {
            var form = new Form {
                Text = title + " " + (i + 1), StartPosition = FormStartPosition.Manual,
                Location = new Point(x + i * 30, y + i * 30), Size = new Size(360, 220)
            };
            form.Controls.Add(new Label { Text = "Disposable Seelen integration test window. No user data.", Dock = DockStyle.Fill });
            forms[i] = form;
            form.Show();
            // The launcher hides any console; explicitly show the test form.
            ShowWindow(form.Handle, 5);
        }
        // Fail-safe if the test runner is interrupted.
        var timer = new Timer { Interval = 120000 };
        timer.Tick += (sender, e) => Application.Exit();
        timer.Start();
        Application.Run(forms[0]);
        timer.Dispose();
        foreach (var form in forms) form.Dispose();
    }
}
