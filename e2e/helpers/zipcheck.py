# Confere o zip fora do navegador, com outra implementação: zipfile é o que um extrator comum veria.
import json
import sys
import zipfile

path = sys.argv[1]
out = {"names": [], "bad": None, "bad_paths": [], "sizes": {}, "texts": {}}
with zipfile.ZipFile(path) as z:
    out["bad"] = z.testzip()
    for info in z.infolist():
        name = info.filename
        out["names"].append(name)
        out["sizes"][name] = info.file_size
        parts = name.split("/")
        if ".." in parts or "\\" in name or name.startswith("/") or ":" in name or any(not p for p in parts):
            out["bad_paths"].append(name)
        if name.endswith((".txt", ".csv", ".c", ".h", ".cpp", ".json")) and info.file_size < 200_000:
            out["texts"][name] = z.read(info).decode("utf-8", "replace")
print(json.dumps(out))
