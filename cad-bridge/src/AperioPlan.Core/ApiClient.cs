using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading.Tasks;

namespace AperioPlan.Core
{
    public class ApiException : Exception
    {
        public int Status { get; }
        public ApiException(int status, string message) : base(message) { Status = status; }
    }

    /// <summary>
    /// Zugriff auf die AperioPlan-Schnittstelle mit einem persönlichen API-Schlüssel
    /// (Einstellungen → API-Schlüssel). Alle Aufrufe laufen verschlüsselt über HTTPS.
    /// </summary>
    public class ApiClient : IDisposable
    {
        private readonly HttpClient _http;
        public string BaseUrl { get; }

        public ApiClient(string baseUrl, string token, TimeSpan? timeout = null)
        {
            if (string.IsNullOrWhiteSpace(baseUrl)) throw new ArgumentException("Server-Adresse fehlt");
            BaseUrl = baseUrl.TrimEnd('/');
#if NETFRAMEWORK
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
#endif
            _http = new HttpClient { Timeout = timeout ?? TimeSpan.FromMinutes(30) };
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
            _http.DefaultRequestHeaders.UserAgent.ParseAdd("AperioPlan-CadBridge/1.0");
        }

        public void Dispose() => _http.Dispose();

        private string Url(string path) => path.StartsWith("http") ? path : BaseUrl + (path.StartsWith("/api") ? path : "/api" + path);

        private static async Task<object> Read(HttpResponseMessage res)
        {
            string text = await res.Content.ReadAsStringAsync().ConfigureAwait(false);
            if (!res.IsSuccessStatusCode)
            {
                string msg = res.ReasonPhrase;
                try { msg = Json.ParseObject(text)?.Str("error") ?? msg; } catch { /* kein JSON */ }
                throw new ApiException((int)res.StatusCode, msg);
            }
            return string.IsNullOrEmpty(text) ? null : Json.Parse(text);
        }

        public async Task<object> SendAsync(HttpMethod method, string path, object body = null)
        {
            using (var req = new HttpRequestMessage(method, Url(path)))
            {
                if (body != null) req.Content = new StringContent(Json.Stringify(body), Encoding.UTF8, "application/json");
                using (var res = await _http.SendAsync(req).ConfigureAwait(false)) return await Read(res).ConfigureAwait(false);
            }
        }

        /// <summary>Synchroner Aufruf – sicher im SolidWorks-UI-Thread, da intern ConfigureAwait(false).</summary>
        public object Send(HttpMethod method, string path, object body = null) => Task.Run(() => SendAsync(method, path, body)).GetAwaiter().GetResult();
        public Dictionary<string, object> Get(string path) => Send(HttpMethod.Get, path) as Dictionary<string, object>;
        public List<object> GetList(string path) => Send(HttpMethod.Get, path) as List<object> ?? new List<object>();
        public Dictionary<string, object> Post(string path, object body = null) => Send(HttpMethod.Post, path, body ?? new Dictionary<string, object>()) as Dictionary<string, object>;

        public async Task<Dictionary<string, object>> UploadAsync(string path, string filePath, IDictionary<string, string> fields = null)
        {
            using (var content = new MultipartFormDataContent())
            {
                if (fields != null) foreach (var f in fields) content.Add(new StringContent(f.Value ?? "", Encoding.UTF8), f.Key);
                var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                var fileContent = new StreamContent(stream);
                fileContent.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
                content.Add(fileContent, "file", Path.GetFileName(filePath));
                using (var res = await _http.PostAsync(Url(path), content).ConfigureAwait(false))
                    return await Read(res).ConfigureAwait(false) as Dictionary<string, object>;
            }
        }

        /// <summary>Mehrere Dateien in einem Aufruf hochladen (Feldname, Pfad)</summary>
        public async Task<Dictionary<string, object>> UploadFilesAsync(string path, IList<KeyValuePair<string, string>> files, IDictionary<string, string> fields = null)
        {
            using (var content = new MultipartFormDataContent())
            {
                var streams = new List<Stream>();
                try
                {
                    if (fields != null) foreach (var f in fields) content.Add(new StringContent(f.Value ?? "", Encoding.UTF8), f.Key);
                    foreach (var f in files)
                    {
                        var stream = new FileStream(f.Value, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                        streams.Add(stream);
                        var fc = new StreamContent(stream);
                        fc.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
                        content.Add(fc, f.Key, Path.GetFileName(f.Value));
                    }
                    using (var res = await _http.PostAsync(Url(path), content).ConfigureAwait(false))
                        return await Read(res).ConfigureAwait(false) as Dictionary<string, object>;
                }
                finally { foreach (var s in streams) s.Dispose(); }
            }
        }

        public Dictionary<string, object> UploadFiles(string path, IList<KeyValuePair<string, string>> files, IDictionary<string, string> fields = null)
            => Task.Run(() => UploadFilesAsync(path, files, fields)).GetAwaiter().GetResult();

        public Dictionary<string, object> Upload(string path, string filePath, IDictionary<string, string> fields = null)
            => Task.Run(() => UploadAsync(path, filePath, fields)).GetAwaiter().GetResult();

        public async Task DownloadAsync(string path, string targetFile)
        {
            using (var res = await _http.GetAsync(Url(path), HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false))
            {
                if (!res.IsSuccessStatusCode) await Read(res).ConfigureAwait(false);
                Directory.CreateDirectory(Path.GetDirectoryName(targetFile));
                string tmp = targetFile + ".download";
                using (var src = await res.Content.ReadAsStreamAsync().ConfigureAwait(false))
                using (var dst = new FileStream(tmp, FileMode.Create, FileAccess.Write))
                    await src.CopyToAsync(dst).ConfigureAwait(false);
                if (File.Exists(targetFile))
                {
                    File.SetAttributes(targetFile, FileAttributes.Normal);
                    File.Delete(targetFile);
                }
                File.Move(tmp, targetFile);
            }
        }

        public void Download(string path, string targetFile) => Task.Run(() => DownloadAsync(path, targetFile)).GetAwaiter().GetResult();

        // ------------------------------------------------------------ Fachliche Aufrufe
        public Dictionary<string, object> Me() => Get("/auth/me");

        /// <summary>Version dieses Wächters (aus Directory.Build.props)</summary>
        public static string BridgeVersion
        {
            get
            {
                var v = typeof(ApiClient).Assembly.GetName().Version;
                return v == null ? "" : $"{v.Major}.{v.Minor}.{v.Build}";
            }
        }

        /// <summary>
        /// Lebenszeichen an den Server: erscheint unter „Verbundene Arbeitsplätze“.
        /// Liefert updateAvailable/latestVersion/downloadUrl zurück.
        /// </summary>
        public Dictionary<string, object> Hello(string kind, string appVersion)
        {
            string os = System.Runtime.InteropServices.RuntimeInformation.OSDescription;
            return Post("/bridge/hello", new Dictionary<string, object>
            {
                ["kind"] = kind, ["host"] = Environment.MachineName, ["os"] = os, ["version"] = BridgeVersion, ["appVersion"] = appVersion ?? "",
            });
        }
        public SaveMask GetMask() => SaveMask.From(Get("/cad/mask"));

        public List<Project> Projects() => GetList("/projects").Cast<Dictionary<string, object>>().Select(Project.From).ToList();

        public CadItem Resolve(string fileName)
        {
            var r = Get("/cad/resolve?fileName=" + Uri.EscapeDataString(fileName));
            return r.Bool("managed") ? CadItem.From(r.Obj("item")) : null;
        }

        public string PreviewNumber(string projectId, int sub, int subsub, string designation)
            => Post("/cad/numbers/preview", new Dictionary<string, object> { ["projectId"] = projectId, ["sub"] = sub, ["subsub"] = subsub, ["designation"] = designation }).Str("fileStem");

        public CreateResult CreateItem(string projectId, CadType type, int sub, int subsub, string designation, string procurement,
            Dictionary<string, string> properties, bool createDrawing, string host, string drawingOf = null)
        {
            var body = new Dictionary<string, object>
            {
                ["projectId"] = projectId, ["type"] = CadTypes.ToApi(type), ["sub"] = sub, ["subsub"] = subsub, ["designation"] = designation,
                ["procurement"] = procurement, ["properties"] = properties, ["createDrawing"] = createDrawing, ["checkout"] = true, ["host"] = host,
            };
            if (drawingOf != null) body["drawingOf"] = drawingOf;
            var r = Post("/cad/items", body);
            var result = new CreateResult { Item = CadItem.From(r.Obj("item")), Drawing = CadItem.From(r.Obj("drawing")), DrawingTemplate = r.Str("drawingTemplate") };
            var cp = r.Obj("customProperties");
            if (cp != null) foreach (var kv in cp) result.CustomProperties[kv.Key] = kv.Value?.ToString() ?? "";
            return result;
        }

        public Dictionary<string, object> GetItemDetail(string id) => Get("/cad/items/" + id);

        public Dictionary<string, string> CustomProperties(string id)
        {
            var d = GetItemDetail(id).Obj("customProperties");
            var r = new Dictionary<string, string>();
            if (d != null) foreach (var kv in d) r[kv.Key] = kv.Value?.ToString() ?? "";
            return r;
        }

        public CadItem Checkout(string id, string host) => CadItem.From(Post("/cad/items/" + id + "/checkout", new Dictionary<string, object> { ["host"] = host }));
        public CadItem UndoCheckout(string id) => CadItem.From(Post("/cad/items/" + id + "/undo-checkout"));

        public List<string> Checkin(string id, string file, string comment, Dictionary<string, string> properties, List<Reference> references, bool keepCheckedOut)
        {
            var fields = new Dictionary<string, string> { ["comment"] = comment ?? "", ["keepCheckedOut"] = keepCheckedOut ? "true" : "false" };
            if (properties != null) fields["properties"] = Json.Stringify(properties);
            if (references != null)
                fields["references"] = Json.Stringify(references.Select(r => new Dictionary<string, object> { ["number"] = r.FileName, ["quantity"] = r.Quantity }).ToList());
            var r = Upload("/cad/items/" + id + "/checkin", file, fields);
            return r.Arr("unknownReferences").Select(x => x.ToString()).ToList();
        }

        public CadItem Revise(string id, string reason, string host)
            => CadItem.From(Post("/cad/items/" + id + "/revise", new Dictionary<string, object> { ["reason"] = reason, ["host"] = host }));

        public CadItem SetState(string id, string to, string comment)
            => CadItem.From(Post("/cad/items/" + id + "/state", new Dictionary<string, object> { ["to"] = to, ["comment"] = comment ?? "" }));

        public List<Dictionary<string, object>> WhereUsed(string id) => GetList("/cad/items/" + id + "/where-used").Cast<Dictionary<string, object>>().ToList();

        public ExportJob ClaimExport(string worker, IEnumerable<string> formats)
        {
            var r = Post("/cad/exports/claim", new Dictionary<string, object> { ["worker"] = worker, ["formats"] = formats.ToList() });
            var j = r.Obj("job");
            if (j == null) return null;
            var model = j.Obj("referencedModel");
            return new ExportJob
            {
                Id = j.Str("id"), Format = j.Str("format"), Revision = j.Int("revision"), DownloadUrl = j.Str("downloadUrl"),
                TargetName = j.Str("targetName"), Item = CadItem.From(j.Obj("item")),
                ReferencedModelUrl = model?.Str("downloadUrl"), ReferencedModelFileName = model?.Str("fileName"),
            };
        }

        public void CompleteExport(string jobId, string file) => Upload("/cad/exports/" + jobId + "/complete", file);
        public void FailExport(string jobId, string error) => Post("/cad/exports/" + jobId + "/fail", new Dictionary<string, object> { ["error"] = error });
    }
}
