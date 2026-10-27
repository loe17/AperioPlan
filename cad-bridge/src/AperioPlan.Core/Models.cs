using System.Collections.Generic;
using System.Linq;

namespace AperioPlan.Core
{
    public enum CadType { Part, Assembly, Drawing }

    public static class CadTypes
    {
        public static string ToApi(CadType t) => t == CadType.Assembly ? "assembly" : t == CadType.Drawing ? "drawing" : "part";
        public static CadType FromApi(string s) => s == "assembly" ? CadType.Assembly : s == "drawing" ? CadType.Drawing : CadType.Part;

        public static CadType? FromFileName(string fileName)
        {
            string ext = System.IO.Path.GetExtension(fileName ?? "").ToLowerInvariant();
            if (ext == ".sldprt") return CadType.Part;
            if (ext == ".sldasm") return CadType.Assembly;
            if (ext == ".slddrw") return CadType.Drawing;
            return null;
        }
    }

    public class Project
    {
        public string Id, Number, Name, FolderPath;
        public static Project From(Dictionary<string, object> d) => new Project
        {
            Id = d.Str("id"), Number = d.Str("number"), Name = d.Str("name"), FolderPath = d.Str("folderPath"),
        };
        public override string ToString() => Number + "  " + Name;
    }

    public class MaskField
    {
        public string Key, Label, Type, Catalog, DefaultValue;
        public bool Required;
        public List<string> AppliesTo;

        public bool AppliesToType(CadType t) => AppliesTo == null || AppliesTo.Count == 0 || AppliesTo.Contains(CadTypes.ToApi(t));
    }

    public class Catalog
    {
        public string Name, Label;
        public List<string> Values = new List<string>();
    }

    public class SaveMask
    {
        public List<MaskField> Fields = new List<MaskField>();
        public List<Catalog> Catalogs = new List<Catalog>();
        public List<KeyValuePair<string, string>> Subassemblies = new List<KeyValuePair<string, string>>();
        public bool AskCreateDrawing;
        public string DrawingTemplate;
        public string UserDisplayName;

        public static SaveMask From(Dictionary<string, object> d)
        {
            var m = new SaveMask
            {
                AskCreateDrawing = d.Bool("askCreateDrawing"),
                DrawingTemplate = d.Str("drawingTemplate"),
                UserDisplayName = d.Obj("user").Str("displayName"),
            };
            foreach (Dictionary<string, object> f in d.Arr("fields"))
            {
                m.Fields.Add(new MaskField
                {
                    Key = f.Str("key"), Label = f.Str("label"), Type = f.Str("type"), Catalog = f.Str("catalog"),
                    DefaultValue = f.Str("defaultValue"), Required = f.Bool("required"),
                    AppliesTo = f.ContainsKey("appliesTo") && f["appliesTo"] != null ? f.Arr("appliesTo").Select(x => x.ToString()).ToList() : null,
                });
            }
            foreach (Dictionary<string, object> c in d.Arr("catalogs"))
                m.Catalogs.Add(new Catalog { Name = c.Str("name"), Label = c.Str("label"), Values = c.Arr("values").Select(x => x.ToString()).ToList() });
            foreach (Dictionary<string, object> s in d.Arr("subassemblies"))
                m.Subassemblies.Add(new KeyValuePair<string, string>(s.Str("code"), s.Str("label")));
            return m;
        }

        public Catalog FindCatalog(string name) => Catalogs.FirstOrDefault(c => c.Name == name);
    }

    public class CadItem
    {
        public string Id, ProjectId, ProjectNumber, Type, BaseNumber, Number, Designation, State, Procurement;
        public string FilePath, FileName, CheckedOutBy, CheckedOutByName, DrawingId, DrawingOf;
        public int Revision;
        public Dictionary<string, string> Properties = new Dictionary<string, string>();

        public CadType CadType => CadTypes.FromApi(Type);
        public bool IsReleased => State == "released";

        public static CadItem From(Dictionary<string, object> d)
        {
            if (d == null) return null;
            var i = new CadItem
            {
                Id = d.Str("id"), ProjectId = d.Str("projectId"), ProjectNumber = d.Str("projectNumber"), Type = d.Str("type"),
                BaseNumber = d.Str("baseNumber"), Number = d.Str("number"), Designation = d.Str("designation"), State = d.Str("state"),
                Procurement = d.Str("procurement"), FilePath = d.Str("filePath"), FileName = d.Str("fileName"),
                CheckedOutBy = d.Str("checkedOutBy"), CheckedOutByName = d.Str("checkedOutByName"),
                DrawingId = d.Str("drawingId"), DrawingOf = d.Str("drawingOf"), Revision = d.Int("revision"),
            };
            var props = d.Obj("properties");
            if (props != null) foreach (var kv in props) i.Properties[kv.Key] = kv.Value?.ToString() ?? "";
            return i;
        }

        public static string StateLabel(string s) =>
            s == "in_work" ? "In Arbeit" : s == "review" ? "Prüfung" : s == "released" ? "Freigegeben" : s == "obsolete" ? "Ungültig" : s;
    }

    public class CreateResult
    {
        public CadItem Item, Drawing;
        public string DrawingTemplate;
        public Dictionary<string, string> CustomProperties = new Dictionary<string, string>();
    }

    public class ExportJob
    {
        public string Id, Format, DownloadUrl, TargetName;
        public int Revision;
        public CadItem Item;
        public string ReferencedModelUrl, ReferencedModelFileName;
    }

    public class Reference
    {
        public string FileName;
        public int Quantity;
    }
}
