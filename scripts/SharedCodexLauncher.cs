using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
// Compiled locally as AnyCPU; the source package contains no machine paths.
public static class SharedCodexLauncher {
  static async Task Pump(Stream input, Stream output) {
    var buffer=new byte[8192]; int count;
    while((count=await input.ReadAsync(buffer,0,buffer.Length))>0) {
      await output.WriteAsync(buffer,0,count);
      // Redirected StandardInput.BaseStream is buffered on .NET Framework.
      // RPC peers wait for each short message while stdin is still open.
      await output.FlushAsync();
    }
  }
  static string Quote(string s) {
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in s) { if(c=='\\') { slashes++; continue; } if(c=='\"') b.Append('\\',slashes*2+1); else b.Append('\\',slashes); b.Append(c); slashes=0; }
    b.Append('\\',slashes*2); b.Append('"'); return b.ToString();
  }
  public static int Main(string[] args) {
    try {
      var root=System.IO.Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
      var lines=System.IO.File.ReadAllLines(System.IO.Path.Combine(root,"launcher-paths.txt"));
      var command=new StringBuilder(); command.Append(Quote(lines[1])); command.Append(' '); command.Append(Quote(lines[2]));
      foreach(var arg in args) { command.Append(' '); command.Append(Quote(arg)); }
      using(var child=Process.Start(new ProcessStartInfo(lines[0],command.ToString()){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true})) {
        Task.Run(async()=>{try{await Pump(Console.OpenStandardInput(),child.StandardInput.BaseStream);}catch{}finally{try{child.StandardInput.Close();}catch{}}});
        var output=Task.Run(()=>Pump(child.StandardOutput.BaseStream,Console.OpenStandardOutput()));
        var errors=Task.Run(()=>Pump(child.StandardError.BaseStream,Console.OpenStandardError()));
        child.WaitForExit();Task.WaitAll(output,errors);return child.ExitCode;
      }
    } catch { Console.Error.WriteLine("无法启动桌面共享连接，请重新准备连接。"); return 1; }
  }
}
