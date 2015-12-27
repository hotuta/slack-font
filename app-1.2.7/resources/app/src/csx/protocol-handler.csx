using System;
using System.Threading.Tasks;
using SlackNotifier;

public class Startup
{
  public async Task<object> Invoke(dynamic args)
  {
    try {
      if ((bool)args.register) {
        var exePath = (string)args.exePath;
        ProtocolHandler.Register(exePath);
      } else {
        ProtocolHandler.Unregister();
      }
      return "";
    } catch (Exception ex) {
      Console.WriteLine(ex.ToString());
      return ex.ToString();
    }
  }
}