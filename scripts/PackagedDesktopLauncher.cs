using System;
using System.IO;
using System.Diagnostics;
// Activated inside the installed MSIX identity, like the desktop shortcut.
// Package activation does not inherit environment variables from its caller.
public static class PackagedDesktopLauncher {
  public static int Main(string[] args) {
    if (args.Length!=3) return 1;
    try {
      if (!File.Exists(args[0]) || !File.Exists(args[1])) throw new IOException();
      var info=new ProcessStartInfo(args[0]) {UseShellExecute=false};
      info.EnvironmentVariables["CODEX_CLI_PATH"]=args[1];
      using(var child=Process.Start(info)) { if(child==null) throw new IOException(); }
      File.WriteAllText(args[2],"{\"ok\":true}");return 0;
    } catch {
      File.WriteAllText(args[2],"{\"ok\":false,\"error\":\"Windows packaged desktop launch failed\"}");return 1;
    }
  }
}
