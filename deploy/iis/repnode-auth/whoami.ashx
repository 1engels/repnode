<%@ WebHandler Language="C#" Class="RepNodeWhoAmI" %>

using System.Web;

/// <summary>
/// Devuelve el usuario de la sesión de PME ({"user":"..."}) para que RepNode sepa quién es el usuario.
/// PME no expone un endpoint JSON con el usuario actual, así que esta aplicación mínima valida la misma cookie de
/// Forms Authentication de PME (.APPLICATIONFRAMEWORK) con el machineKey que hereda del web.config raíz del sitio.
/// Solo lee la cookie: no modifica nada de PME ni emite cookies. Solo responde a peticiones de este mismo equipo.
/// </summary>
public class RepNodeWhoAmI : IHttpHandler
{
    public bool IsReusable { get { return true; } }

    public void ProcessRequest(HttpContext ctx)
    {
        HttpResponse res = ctx.Response;
        res.Cache.SetCacheability(HttpCacheability.NoCache);
        res.Cache.SetNoStore();
        res.TrySkipIisCustomErrors = true;

        // Lo consulta RepNode desde 127.0.0.1; desde otro equipo no se responde
        if (!ctx.Request.IsLocal)
        {
            res.StatusCode = 403;
            return;
        }

        System.Security.Principal.IPrincipal user = ctx.User;
        if (user == null || user.Identity == null || !user.Identity.IsAuthenticated || user.Identity.AuthenticationType != "Forms")
        {
            res.StatusCode = 401;
            return;
        }

        res.ContentType = "application/json";
        res.Write("{\"user\":" + HttpUtility.JavaScriptStringEncode(user.Identity.Name, true) + "}");
    }
}
