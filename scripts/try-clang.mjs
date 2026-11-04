// Confere o compilador no Node: bibliotecas essenciais, exceções, pilha e tempo.
import { runClang } from '@yowasp/clang'
import { WASI } from 'node:wasi'

const programs = {
  'hello.c': ['clang', '-std=c17', `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <ctype.h>
int main(void) { char b[32]; strcpy(b, "ok"); printf("%s %d %.3f\\n", b, toupper('a'), sqrt(2.0)); return 0; }`],
  'stl.cpp': ['clang++', '-std=c++20', `#include <iostream>
#include <vector>
#include <map>
#include <set>
#include <string>
#include <algorithm>
#include <queue>
#include <stack>
#include <sstream>
#include <iomanip>
#include <numeric>
#include <unordered_map>
int main() { std::vector<int> v{3,1,2}; std::sort(v.begin(), v.end()); std::map<std::string,int> m{{"a",1}}; std::cout << v[0] << m["a"] << std::accumulate(v.begin(), v.end(), 0) << std::endl; }`],
  'throw.cpp': ['clang++', '-std=c++20', `#include <iostream>
#include <stdexcept>
int main() { try { throw std::runtime_error("x"); } catch (const std::exception& e) { std::cout << "pegou " << e.what() << std::endl; } }`],
  'deep.c': ['clang', '-std=c17', `#include <stdio.h>
int f(int n) { volatile char pad[256]; pad[0] = n; return n ? f(n - 1) + pad[0] - n + 1 : 0; }
int main(void) { printf("%d\\n", f(20000)); return 0; }`],
}

for (const [name, [cc, std, src]] of Object.entries(programs)) {
  const start = performance.now()
  let log = ''
  try {
    const out = await runClang(
      [cc, std, '-O1', name, '-o', 'a.wasm', '-Wl,-z,stack-size=8388608', '-Wl,--max-memory=268435456'],
      { [name]: src },
      { stdout: null, stderr: (b) => b && (log += new TextDecoder().decode(b)) },
    )
    const ms = Math.round(performance.now() - start)
    console.log(`${name}: compilou em ${ms} ms, ${out['a.wasm'].length} bytes`)
    const wasi = new WASI({ version: 'preview1', args: ['a'] })
    const instance = await WebAssembly.instantiate(await WebAssembly.compile(out['a.wasm']), { wasi_snapshot_preview1: wasi.wasiImport })
    console.log('  saída código', wasi.start(instance))
  } catch (err) {
    console.log(`${name}: FALHOU ${err.constructor.name} ${err.code ?? ''} ${err.message ?? ''}\n${log.slice(0, 600)}`)
  }
}
