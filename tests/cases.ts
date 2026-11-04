import type { CompileResult, RunResult } from '../src/compiler/client'
import { compile, parseDiagnostics, run } from '../src/compiler/client'
import { RUN_LIMITS } from '../shared/protocol'

const R = String.raw

export interface Outcome {
  compile: CompileResult
  run?: RunResult
  // saída na ordem de chegada, stdout e stderr misturados
  merged: string
  log: string
}

export interface Expect {
  compile?: 'ok' | 'error'
  // aceita compilar ou não: quem decide é o check
  anyCompile?: boolean
  // não exige código 0 nem ausência de erro
  anyExit?: boolean
  log?: RegExp
  logNot?: RegExp
  internal?: boolean
  diags?: { file: string; line: number; column?: number; severity?: string; message?: RegExp }[]
  exit?: number
  stdout?: string | RegExp
  stderr?: string | RegExp
  merged?: string | RegExp
  timedOut?: boolean
  // null exige que não haja erro de execução
  error?: RegExp | null
  check?: (o: Outcome) => string | null | undefined
}

export interface Case extends Expect {
  id: string
  group: string
  lang?: 'c' | 'cpp'
  files?: Record<string, string>
  stdin?: string
  timeoutMs?: number
  harnessMs?: number
  // Quando o ideal falha e não há conserto: o resultado real, conferido, vira limite conhecido.
  knownLimit?: { reason: string; actual?: Expect }
  // Observação honesta sobre o comportamento, vai para o relatório.
  note?: string
  sanity?: boolean
  // tempos máximos: compilação e quanto a página pode ficar sem responder
  maxCompileMs?: number
  maxLagMs?: number
  // Cenário livre: devolve falhas, observações e métricas.
  scenario?: (api: ScenarioApi) => Promise<ScenarioResult>
}

export interface ScenarioResult {
  failures: string[]
  notes?: string[]
  metrics?: Record<string, unknown>
}

export interface ScenarioApi {
  compile: typeof compile
  run: typeof run
  parseDiagnostics: typeof parseDiagnostics
  mustCompile: (lang: 'c' | 'cpp', src: string) => Promise<Uint8Array<ArrayBuffer>>
}

const cases: Case[] = []
let group = ''
const c = (id: string, src: string, o: Partial<Case> = {}) => cases.push({ id: `${group}.${id}`, group, lang: 'c', files: { 'main.c': src }, ...o })
const cpp = (id: string, src: string, o: Partial<Case> = {}) => cases.push({ id: `${group}.${id}`, group, lang: 'cpp', files: { 'main.cpp': src }, ...o })
const multi = (id: string, lang: 'c' | 'cpp', files: Record<string, string>, o: Partial<Case> = {}) => cases.push({ id: `${group}.${id}`, group, lang, files, ...o })
const scenario = (id: string, fn: Case['scenario'], o: Partial<Case> = {}) => cases.push({ id: `${group}.${id}`, group, scenario: fn, ...o })

const ABORT = /abortado/i
const MEM = /mem[oó]ria/i
const STACK = /pilha|recurs/i
const EXC = /exce[cç][oõ]es/
const IMPORT = /fun[cç][aã]o|importa|n[aã]o existe|n[aã]o dispon/i
const NO_EXC = 'Este build do clang não tem exceções de C++: throw encerra o programa, catch nunca pega nada.'
const ran = (o: Outcome) => (o.run ? null : 'sem execução')

// ---------------------------------------------------------------- headers de C
group = 'c-header'
c('stdio', R`#include <stdio.h>
int main(void) { char b[32]; snprintf(b, sizeof b, "%05d|%-3s|%+.1e", 42, "a", 1234.5);
  printf("%s %d %s %.2f %c %x %o %5.1f%%\n", b, 42, "oi", 3.14159, 'z', 255, 8, 99.5);
  int a; char s[8]; sscanf("12 ab", "%d %7s", &a, s); printf("%d %s\n", a, s); puts("fim"); return 0; }`,
  { stdout: '00042|a  |+1.2e+03 42 oi 3.14 z ff 10  99.5%\n12 ab\nfim\n' })
c('stdlib', R`#include <stdio.h>
#include <stdlib.h>
int cmp(const void *a, const void *b) { return *(int *)a - *(int *)b; }
int main(void) { int v[] = {5, 2, 9, 1}; qsort(v, 4, sizeof(int), cmp); int *p = malloc(8 * sizeof *p); p[7] = atoi("33");
  char *e; long l = strtol("ff", &e, 16); double d = atof("2.5");
  printf("%d%d%d%d %d %ld %.1f %d %d\n", v[0], v[1], v[2], v[3], p[7], l, d, abs(-4), div(7, 2).quot);
  p = realloc(p, 64); free(p); int *z = calloc(2, 4); printf("%d\n", z[1]); free(z); return EXIT_SUCCESS; }`,
  { stdout: '1259 33 255 2.5 4 3\n0\n' })
c('string', R`#include <stdio.h>
#include <string.h>
int main(void) { char b[32]; strcpy(b, "abc"); strcat(b, "def"); printf("%zu %d %s %s\n", strlen(b), strcmp("a", "a"), strchr(b, 'd'), strstr(b, "cd"));
  memset(b, 'z', 3); b[3] = 0; char d[8]; memcpy(d, b, 4); memmove(d + 1, d, 2); printf("%s %s\n", d, strrchr("a/b/c", '/'));
  char t[] = "a,b"; printf("%s\n", strtok(t, ",")); return 0; }`,
  { stdout: '6 0 def cdef\nzzz /c\na\n' })
c('math', R`#include <math.h>
#include <stdio.h>
int main(void) { volatile double x = 2.0, y = 2.7, z = 0.0;
  printf("%.3f %.0f %.0f %.0f %.0f %.0f %.0f %.5f %.0f %.0f %.0f %.0f\n", sqrt(x), pow(x, 10), floor(y), ceil(y), sin(z), fabs(-x), fmod(7, x + 1), atan2(x, x) * 4, exp(z), hypot(x + 1, x + 2), cbrt(x * 13.5), round(y));
  printf("%.4f %.4f %.4f\n", log(x), log10(x * 5), cos(z)); return 0; }`,
  { stdout: '1.414 1024 2 3 0 2 1 3.14159 1 5 3 3\n0.6931 1.0000 1.0000\n' })
c('ctype', R`#include <ctype.h>
#include <stdio.h>
int main(void) { printf("%d %d %d %c %c %d %d\n", !!isalpha('a'), !!isdigit('5'), !!isspace(' '), toupper('a'), tolower('Z'), !!ispunct('!'), !!isalnum('_')); return 0; }`,
  { stdout: '1 1 1 A z 1 0\n' })
c('stdbool', R`#include <stdbool.h>
#include <stdio.h>
int main(void) { bool b = true; printf("%d %d %zu\n", b, !b, sizeof(bool)); return 0; }`, { stdout: '1 0 1\n' })
c('limits', R`#include <limits.h>
#include <stdio.h>
int main(void) { printf("%d %d %d %d %ld %lld %zu %zu\n", INT_MAX, INT_MIN, CHAR_BIT, UCHAR_MAX, LONG_MAX, LLONG_MAX, sizeof(long), sizeof(void *)); return 0; }`,
  { stdout: '2147483647 -2147483648 8 255 2147483647 9223372036854775807 4 4\n', note: 'wasm32: long e ponteiro têm 4 bytes, como no Windows. Quem espera long de 64 bits (Linux) tem overflow.' })
c('time', R`#include <stdio.h>
#include <time.h>
int main(void) { time_t t = time(NULL); time_t z = 0; struct tm *g = gmtime(&z); char b[32]; strftime(b, sizeof b, "%Y-%m-%d", g);
  printf("%d %s %.0f\n", t > 1600000000, b, difftime(5, 3)); struct tm *l = localtime(&t); printf("%d\n", l->tm_year > 100); return 0; }`,
  { stdout: '1 1970-01-01 2\n1\n' })
c('stdint', R`#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
int main(void) { int64_t x = INT64_MAX; volatile uint8_t u = 255; u++; printf("%" PRId64 " %d %zu %" PRIu32 "\n", x, u, sizeof(intptr_t), UINT32_MAX); return 0; }`,
  { stdout: '9223372036854775807 0 4 4294967295\n' })
c('assert', R`#include <assert.h>
#include <stdio.h>
int main(void) { volatile int a = 1; assert(a + 1 == 2); puts("ok"); return 0; }`, { stdout: 'ok\n' })
c('errno', R`#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void) { errno = 0; strtol("99999999999999999999999", 0, 10); printf("%d %s\n", errno == ERANGE, strerror(ENOENT)); return 0; }`,
  { stdout: '1 No such file or directory\n' })
c('float', R`#include <float.h>
#include <stdio.h>
int main(void) { printf("%d %d %.3g %d\n", DBL_DIG, DBL_MANT_DIG, FLT_EPSILON, FLT_MAX > 1e38f); return 0; }`, { stdout: '15 53 1.19e-07 1\n' })
c('stdarg', R`#include <stdarg.h>
#include <stdio.h>
int soma(int n, ...) { va_list a; va_start(a, n); int s = 0; while (n--) s += va_arg(a, int); va_end(a); return s; }
int main(void) { printf("%d\n", soma(3, 1, 2, 3)); return 0; }`, { stdout: '6\n' })
c('complex-vla', R`#include <complex.h>
#include <stddef.h>
#include <stdio.h>
struct S { char a; int b; };
int main(void) { double complex z = 3 + 4 * I; volatile int n = 5; int v[n]; for (int i = 0; i < n; i++) v[i] = i; printf("%.0f %d %zu\n", cabs(z), v[4], offsetof(struct S, b)); return 0; }`,
  { stdout: '5 4 4\n' })
c('setlocale-pt', R`#include <locale.h>
#include <stdio.h>
int main(void) { setlocale(LC_ALL, "Portuguese"); printf("ação\n"); return 0; }`, { stdout: 'ação\n', note: 'setlocale(LC_ALL, "Portuguese"), comum em aula, é inofensivo.' })
c('long-double', R`#include <stdio.h>
int main(void) { long double x = 1.5L; printf("%.2Lf\n", x); scanf("%Lf", &x); printf("%.1Lf\n", x); return 0; }`, { stdin: '2.5', stdout: '1.50\n2.5\n' })
c('signal', R`#include <signal.h>
#include <stdio.h>
void h(int s) { printf("sinal %d\n", s); }
int main(void) { signal(SIGINT, h); raise(SIGINT); puts("ok"); return 0; }`, { stdout: 'sinal 2\nok\n' })
c('setjmp', R`#include <setjmp.h>
#include <stdio.h>
jmp_buf j;
int main(void) { if (setjmp(j) == 0) { puts("a"); longjmp(j, 1); } puts("b"); return 0; }`,
  { stdout: 'a\nb\n', knownLimit: { reason: 'setjmp/longjmp exige exceções de wasm, que este build não tem. O aluno recebe erro de compilação claro.', actual: { compile: 'error', log: /setjmp|longjmp/i } } })
c('clock', R`#include <stdio.h>
#include <time.h>
int main(void) { clock_t a = clock(); volatile long s = 0; for (long i = 0; i < 1000000; i++) s += i; clock_t b = clock(); printf("%d %d\n", b >= a, CLOCKS_PER_SEC > 0); return 0; }`, { stdout: '1 1\n' })
c('m-pi', R`#include <math.h>
#include <stdio.h>
int main(void) { printf("%.4f %.4f\n", M_PI, M_E); return 0; }`, { stdout: '3.1416 2.7183\n', note: 'gcc aceita por padrão: o aluno não pode ver M_PI undeclared.' })
c('posix-basico', R`#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <stdlib.h>
#include <unistd.h>
int main(void) { char *s = strdup("abc"); printf("%s %d\n", s, strcasecmp("A", "a")); free(s); srandom(1); printf("%d\n", random() >= 0); char *l = NULL; size_t n = 0; printf("%d\n", (int)getline(&l, &n, stdin)); return 0; }`, { stdin: 'xy\n', stdout: 'abc 0\n1\n3\n' })
c('void-main', R`#include <stdio.h>
void main(void) { puts("oi"); }`, { stdout: 'oi\n', knownLimit: { reason: 'O clang em wasm só liga main nas formas int main() e int main(int, char **). void main, aceito pelo gcc, vira erro de compilação claro em vez de abortar ao rodar.', actual: { compile: 'error', internal: false, log: /int main\(\)/ } } })
c('main-k-and-r', R`#include <stdio.h>
int main() { puts("oi"); return 0; }`, { stdout: 'oi\n' })
c('main-um-parametro', R`int main(int a) { return a - 1; }`, { exit: 0, knownLimit: { reason: 'O clang em wasm só liga main nas formas int main() e int main(int, char **). void main, aceito pelo gcc, vira erro de compilação claro em vez de abortar ao rodar.', actual: { compile: 'error', internal: false, log: /int main\(\)/ } } })
c('main-tres-parametros', R`int main(int a, char **v, char **e) { return a - 1; }`, { exit: 0, knownLimit: { reason: 'O clang em wasm só liga main nas formas int main() e int main(int, char **). void main, aceito pelo gcc, vira erro de compilação claro em vez de abortar ao rodar.', actual: { compile: 'error', internal: false, log: /int main\(\)/ } } })
c('conio-ausente', R`#include <conio.h>
int main(void) { getch(); return 0; }`, { compile: 'error', internal: false, diags: [{ file: 'main.c', line: 1, severity: 'error', message: /conio\.h.*not found/ }] })
c('system-pause', R`#include <stdlib.h>
#include <stdio.h>
int main(void) { puts("oi"); system("pause"); return 0; }`, { compile: 'error', internal: false, log: /system/, note: 'system("pause") é erro de compilação: wasi-libc não declara system.' })

// -------------------------------------------------------------- headers de C++
group = 'cpp-header'
cpp('iostream', R`#include <iostream>
#include <string>
int main() { int a; std::string s; std::cin >> a >> s; std::cout << a * 2 << ' ' << s << std::endl; std::cerr << "err\n"; }`, { stdin: '21 oi', stdout: '42 oi\n', stderr: 'err\n' })
cpp('vector', R`#include <algorithm>
#include <iostream>
#include <vector>
int main() { std::vector<int> v{3, 1, 2}; v.push_back(9); std::sort(v.begin(), v.end()); v.erase(v.begin()); v.insert(v.begin(), 7); v.emplace_back(8); std::reverse(v.begin(), v.end());
  std::vector<std::vector<int>> m(2, std::vector<int>(2, 5)); for (int x : v) std::cout << x << ' '; std::cout << v.size() << ' ' << v.back() << ' ' << m[1][1] << '\n'; }`, { stdout: '8 9 3 2 7 5 7 5\n' })
cpp('string', R`#include <iostream>
#include <string>
int main() { std::string s = "abc" + std::to_string(12); s += "x"; std::cout << s << ' ' << s.size() << ' ' << s.substr(1, 2) << ' ' << s.find("12") << ' ' << std::stoi("41") + 1 << ' ' << std::stod("1.5") << ' ' << s.replace(0, 1, "Z") << ' ' << (s == "Zbc12x") << '\n'; }`, { stdout: 'abc12x 6 bc 3 42 1.5 Zbc12x 1\n' })
cpp('map', R`#include <iostream>
#include <map>
#include <string>
int main() { std::map<std::string, int> m{{"b", 2}, {"a", 1}}; m["c"] = 3; m.erase("b"); for (auto &[k, v] : m) std::cout << k << v << ' '; std::cout << m.count("z") << ' ' << m.lower_bound("b")->first << '\n'; std::multimap<int, int> mm{{1, 1}, {1, 2}}; std::cout << mm.count(1) << '\n'; }`, { stdout: 'a1 c3 0 c\n2\n' })
cpp('set', R`#include <iostream>
#include <set>
int main() { std::set<int> s{3, 1, 3, 2}; s.insert(0); s.erase(2); for (int x : s) std::cout << x; std::multiset<int> m{1, 1}; std::cout << ' ' << s.size() << ' ' << m.size() << ' ' << *s.upper_bound(1) << '\n'; }`, { stdout: '013 3 2 3\n' })
cpp('unordered_map', R`#include <iostream>
#include <string>
#include <unordered_map>
int main() { std::unordered_map<std::string, int> m; for (int i = 0; i < 1000; i++) m[std::to_string(i)] = i; m.erase("5"); std::cout << m.size() << ' ' << m["999"] << ' ' << m.count("5") << '\n'; }`, { stdout: '999 999 0\n' })
cpp('unordered_set', R`#include <iostream>
#include <unordered_set>
int main() { std::unordered_set<int> s; for (int i = 0; i < 5000; i++) s.insert(i % 100); std::cout << s.size() << ' ' << s.count(50) << ' ' << s.count(500) << '\n'; }`, { stdout: '100 1 0\n' })
cpp('queue', R`#include <functional>
#include <iostream>
#include <queue>
#include <vector>
int main() { std::queue<int> q; q.push(1); q.push(2); q.pop(); std::priority_queue<int> p; p.push(1); p.push(5); std::priority_queue<int, std::vector<int>, std::greater<int>> m; m.push(5); m.push(2); std::cout << q.front() << p.top() << m.top() << '\n'; }`, { stdout: '252\n' })
cpp('stack', R`#include <iostream>
#include <stack>
int main() { std::stack<int> s; s.push(1); s.push(2); std::cout << s.top(); s.pop(); std::cout << s.top() << s.size() << s.empty() << '\n'; }`, { stdout: '2110\n' })
cpp('deque', R`#include <deque>
#include <iostream>
int main() { std::deque<int> d{2}; d.push_front(1); d.push_back(3); std::cout << d[0] << d.at(1) << d.back() << d.size() << '\n'; }`, { stdout: '1233\n' })
cpp('list', R`#include <iostream>
#include <list>
int main() { std::list<int> l{3, 1, 2, 2}; l.sort(); l.unique(); l.reverse(); l.push_front(9); for (int x : l) std::cout << x; std::cout << l.size() << '\n'; }`, { stdout: '93214\n' })
cpp('array', R`#include <algorithm>
#include <array>
#include <iostream>
int main() { std::array<int, 3> a{3, 1, 2}; std::sort(a.begin(), a.end()); std::array<int, 2> b; b.fill(7); std::cout << a[0] << a.at(2) << b[1] << a.size() << '\n'; }`, { stdout: '1373\n' })
cpp('algorithm', R`#include <algorithm>
#include <iostream>
#include <vector>
int main() { std::vector<int> v{4, 2, 2, 9}; std::sort(v.begin(), v.end()); auto lb = std::lower_bound(v.begin(), v.end(), 3); std::cout << *lb << *std::max_element(v.begin(), v.end()) << std::count(v.begin(), v.end(), 2) << (std::find(v.begin(), v.end(), 7) == v.end());
  v.erase(std::unique(v.begin(), v.end()), v.end()); std::next_permutation(v.begin(), v.end()); std::rotate(v.begin(), v.begin() + 1, v.end()); for (int x : v) std::cout << ' ' << x; std::cout << ' ' << std::min(1, 2) << std::max(1, 2) << '\n'; }`, { stdout: '4921 9 4 2 12\n' })
cpp('numeric', R`#include <iostream>
#include <numeric>
#include <vector>
int main() { std::vector<int> v(4); std::iota(v.begin(), v.end(), 1); std::vector<int> p(4); std::partial_sum(v.begin(), v.end(), p.begin()); std::cout << std::accumulate(v.begin(), v.end(), 0) << ' ' << std::gcd(12, 18) << ' ' << std::lcm(4, 6) << ' ' << p[3] << ' ' << std::inner_product(v.begin(), v.end(), v.begin(), 0) << '\n'; }`, { stdout: '10 6 12 10 30\n' })
cpp('sstream', R`#include <iostream>
#include <sstream>
#include <string>
int main() { std::stringstream s("12 abc 1.5"); int a; std::string b; double d; s >> a >> b >> d; std::ostringstream o; o << a << '|' << b << '|' << d; std::cout << o.str() << '\n'; }`, { stdout: '12|abc|1.5\n' })
cpp('iomanip', R`#include <iomanip>
#include <iostream>
int main() { std::cout << std::fixed << std::setprecision(2) << 3.14159 << ' ' << std::setw(5) << std::setfill('0') << 42 << ' ' << std::hex << 255 << ' ' << std::boolalpha << true << '\n'; }`, { stdout: '3.14 00042 ff true\n' })
cpp('cmath', R`#include <cmath>
#include <iostream>
int main() { volatile double x = 16; std::cout << std::sqrt(x) << ' ' << std::pow(x, 0.5) << ' ' << std::floor(x / 3) << ' ' << std::abs(-x) << ' ' << std::isnan(x) << '\n'; }`, { stdout: '4 4 5 16 0\n' })
cpp('cstring', R`#include <cstring>
#include <iostream>
int main() { char b[8]; std::strcpy(b, "abc"); std::cout << std::strlen(b) << std::strcmp(b, "abc") << '\n'; }`, { stdout: '30\n' })
cpp('cstdio', R`#include <cstdio>
int main() { int x; std::scanf("%d", &x); std::printf("%d\n", x + 1); }`, { stdin: '1', stdout: '2\n' })
cpp('cstdlib', R`#include <cstdlib>
#include <iostream>
int main() { std::srand(1); int r = std::rand(); std::cout << (r >= 0) << std::atoi("5") << std::abs(-3) << '\n'; return EXIT_SUCCESS; }`, { stdout: '153\n' })
cpp('functional', R`#include <functional>
#include <iostream>
int main() { std::function<int(int)> f = [](int x) { return x * 2; }; auto g = std::bind(std::plus<int>(), std::placeholders::_1, 3); std::function<int(int)> fib = [&](int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }; std::cout << f(2) << g(1) << fib(10) << std::hash<int>{}(5) * 0 << '\n'; }`, { stdout: '44550\n' })
cpp('memory', R`#include <iostream>
#include <memory>
struct A { A() { std::cout << "c"; } ~A() { std::cout << "d"; } int v = 3; };
int main() { { auto u = std::make_unique<A>(); auto m = std::move(u); std::cout << m->v << (u == nullptr); } auto s = std::make_shared<A>(); auto t = s; std::weak_ptr<A> w = s; std::cout << s.use_count() << !w.expired(); t.reset(); s.reset(); std::cout << w.expired() << '\n'; }`, { stdout: 'c31dc21d1\n' })
cpp('utility', R`#include <iostream>
#include <utility>
int main() { std::pair<int, char> p{1, 'a'}; auto q = std::make_pair(2, 'b'); std::swap(p, q); int a = std::exchange(p.first, 9); std::cout << a << p.first << p.second << q.first << q.second << '\n'; }`, { stdout: '29b1a\n' })
cpp('tuple', R`#include <iostream>
#include <string>
#include <tuple>
int main() { auto t = std::make_tuple(1, std::string("x"), 2.5); auto [a, b, c] = t; int d; std::tie(d, std::ignore, std::ignore) = t; std::cout << a << b << c << d << std::get<1>(t) << std::tuple_size_v<decltype(t)> << '\n'; }`, { stdout: '1x2.51x3\n' })
cpp('optional', R`#include <iostream>
#include <optional>
std::optional<int> f(bool b) { if (b) return 7; return std::nullopt; }
int main() { std::cout << f(true).value() << f(false).value_or(3) << f(false).has_value() << '\n'; }`, { stdout: '730\n' })
cpp('variant', R`#include <iostream>
#include <string>
#include <variant>
int main() { std::variant<int, std::string> v = 3; std::cout << std::get<int>(v); v = std::string("s"); std::visit([](auto &x) { std::cout << x; }, v); std::cout << v.index() << std::holds_alternative<int>(v) << '\n'; }`, { stdout: '3s10\n' })
cpp('chrono', R`#include <chrono>
#include <iostream>
int main() { using namespace std::chrono; auto a = steady_clock::now(); volatile long s = 0; for (long i = 0; i < 1000000; i++) s += i; auto b = steady_clock::now(); auto ms = duration_cast<milliseconds>(b - a).count(); auto now = system_clock::now().time_since_epoch(); std::cout << (ms >= 0) << (duration_cast<seconds>(now).count() > 1600000000) << duration_cast<seconds>(minutes(2)).count() << '\n'; }`, { stdout: '11120\n' })
cpp('random', R`#include <iostream>
#include <random>
int main() { std::mt19937 g(42); std::cout << g() << ' '; std::uniform_int_distribution<int> d(1, 6); int x = d(g); std::random_device rd; std::normal_distribution<double> n(0, 1); double y = n(g); std::cout << (x >= 1 && x <= 6) << (y == y) << (rd() == rd() ? 0 : 1) << '\n'; }`, { stdout: '1608637542 111\n' })
cpp('bitset', R`#include <bitset>
#include <iostream>
int main() { std::bitset<8> b(5); b.set(7); std::cout << b << ' ' << b.count() << ' ' << b.to_ulong() << ' ' << b.test(0) << '\n'; }`, { stdout: '10000101 3 133 1\n' })
cpp('climits', R`#include <climits>
#include <iostream>
int main() { std::cout << INT_MAX << ' ' << CHAR_BIT << '\n'; }`, { stdout: '2147483647 8\n' })
cpp('limits', R`#include <iostream>
#include <limits>
int main() { std::cout << std::numeric_limits<int>::max() << ' ' << std::numeric_limits<long long>::min() << ' ' << std::numeric_limits<double>::digits10 << ' ' << (std::numeric_limits<double>::infinity() > 1e308) << '\n'; }`, { stdout: '2147483647 -9223372036854775808 15 1\n' })
cpp('iterator', R`#include <algorithm>
#include <iostream>
#include <iterator>
#include <vector>
int main() { std::vector<int> v{1, 2, 3}, o; std::copy(v.rbegin(), v.rend(), std::back_inserter(o)); std::copy(o.begin(), o.end(), std::ostream_iterator<int>(std::cout, ",")); std::cout << std::distance(v.begin(), v.end()) << *std::next(v.begin()) << '\n'; }`, { stdout: '3,2,1,32\n' })
cpp('string_view', R`#include <iostream>
#include <string_view>
int main() { std::string_view s = "abcdef"; s.remove_prefix(2); std::cout << s << s.substr(1, 2) << s.size() << s.find('e') << s.starts_with("cd") << '\n'; }`, { stdout: 'cdefde421\n' })
cpp('ranges', R`#include <algorithm>
#include <iostream>
#include <ranges>
#include <vector>
int main() { std::vector<int> v{5, 1, 4, 2}; std::ranges::sort(v); for (int x : v | std::views::filter([](int a) { return a % 2 == 0; }) | std::views::transform([](int a) { return a * 10; })) std::cout << x << ' '; for (int i : std::views::iota(0, 3) | std::views::reverse) std::cout << i; std::cout << '\n'; }`, { stdout: '20 40 210\n' })
cpp('concepts', R`#include <concepts>
#include <iostream>
template <std::integral T> T dobra(T x) { return x * 2; }
template <typename T> concept Somavel = requires(T a) { a + a; };
auto soma(Somavel auto a, Somavel auto b) { return a + b; }
int main() { std::cout << dobra(4) << soma(1.5, 1.5) << '\n'; }`, { stdout: '83\n' })
cpp('m-pi', R`#include <cmath>
#include <iostream>
int main() { std::cout << M_PI << '\n'; }`, { stdout: '3.14159\n' })
cpp('classes-rtti', R`#include <iostream>
#include <typeinfo>
struct B { virtual ~B() = default; virtual int f() { return 1; } };
struct D : B { int f() override { return 2; } };
template <class T> T mx(T a, T b) { return a > b ? a : b; }
int main() { B *p = new D; std::cout << p->f() << (dynamic_cast<D *>(p) != nullptr) << (typeid(*p) == typeid(D)) << mx(1, 2) << '\n'; delete p; }`, { stdout: '2112\n' })
cpp('misc-c-wrappers', R`#include <cassert>
#include <cctype>
#include <cstdint>
#include <ctime>
#include <iostream>
int main() { assert(1); std::int64_t x = 1LL << 40; std::cout << x << (char)std::toupper('a') << (std::time(nullptr) > 0) << '\n'; }`, { stdout: '1099511627776A1\n' })
cpp('span-compare', R`#include <compare>
#include <iostream>
#include <span>
#include <vector>
struct P { int x; auto operator<=>(const P &) const = default; };
int main() { std::vector<int> v{1, 2, 3}; std::span<int> s(v); std::cout << s.size() << s[1] << (P{1} < P{2}) << '\n'; }`, { stdout: '321\n' })
cpp('complex-atomic', R`#include <atomic>
#include <complex>
#include <iostream>
int main() { std::complex<double> z(3, 4); std::atomic<int> a{1}; a++; std::cout << std::abs(z) << a.load() << '\n'; }`, { stdout: '52\n' })
cpp('long-double', R`#include <iomanip>
#include <iostream>
int main() { long double x = 1.5L; std::cout << std::fixed << std::setprecision(2) << x << '\n'; long double y; std::cin >> y; std::cout << y * 2 << '\n'; }`, { stdin: '2.5', stdout: '1.50\n5.00\n' })
cpp('format', R`#include <format>
#include <iostream>
int main() { std::cout << std::format("{:>4}|{:.2f}|{}", 7, 3.14159, "x") << '\n'; }`, { stdout: '   7|3.14|x\n' })
cpp('regex', R`#include <iostream>
#include <regex>
#include <string>
int main() { std::smatch m; std::string s = "ab12"; std::regex_search(s, m, std::regex("[0-9]+")); std::cout << m.str() << '\n'; }`, { stdout: '12\n' })
cpp('fstream', R`#include <fstream>
#include <iostream>
int main() { std::ifstream f("nao-existe.txt"); std::ofstream o("saida.txt"); std::cout << f.is_open() << o.is_open() << '\n'; }`, { stdout: '00\n', note: 'fstream compila, mas nenhum arquivo abre: não há sistema de arquivos.' })
cpp('thread', R`#include <iostream>
#include <thread>
int main() { std::thread t([] { std::cout << "t\n"; }); t.join(); }`,
  { stdout: 't\n', knownLimit: { reason: 'wasip1 não tem threads: compila, e criar a thread encerra o programa com mensagem no stderr.', actual: { error: ABORT, stderr: /thread/ } } })
cpp('mutex', R`#include <iostream>
#include <mutex>
std::mutex m;
int main() { std::lock_guard<std::mutex> g(m); std::cout << "ok\n"; }`,
  { stdout: 'ok\n', note: 'std::mutex existe e não faz nada, o que basta com uma thread só.' })
cpp('bits-stdc', R`#include <bits/stdc++.h>
using namespace std;
int main() { vector<int> v{1}; cout << v[0] << '\n'; }`,
  { stdout: '1\n', knownLimit: { reason: 'bits/stdc++.h é de libstdc++ (GCC), não existe em libc++. Quem vem de maratona recebe erro claro e precisa trocar os includes.', actual: { compile: 'error', internal: false, diags: [{ file: 'main.cpp', line: 1, message: /not found/ }] } } })

// ------------------------------------------------------------------- entrada e saída
group = 'io'
c('scanf', R`#include <stdio.h>
int main(void) { int a, b; scanf("%d %d", &a, &b); printf("%d\n", a + b); return 0; }`, { stdin: '2 3\n', stdout: '5\n' })
c('scanf-eof', R`#include <stdio.h>
int main(void) { int x, s = 0, n = 0; while (scanf("%d", &x) == 1) { s += x; n++; } printf("%d %d %d\n", n, s, feof(stdin) != 0); return 0; }`, { stdin: '1 2\n3\n\n4', stdout: '4 10 1\n' })
c('stdin-vazio', R`#include <stdio.h>
int main(void) { int x = 9; int r = scanf("%d", &x); int g = getchar(); char b[8]; char *f = fgets(b, 8, stdin); printf("%d %d %d %d\n", r, x, g, f == NULL); return 0; }`, { stdin: '', stdout: '-1 9 -1 1\n' })
cpp('cin-vazio', R`#include <iostream>
#include <string>
int main() { int x = 9; std::string s = "z"; std::cin >> x; std::cout << x << std::cin.fail() << std::cin.eof(); std::cin.clear(); std::getline(std::cin, s); std::cout << '[' << s << "]\n"; }`, { stdin: '', stdout: '911[]\n' })
cpp('getline-loop', R`#include <iostream>
#include <string>
int main() { std::string l; int n = 0; size_t t = 0; while (std::getline(std::cin, l)) { n++; t += l.size(); std::cout << n << ':' << l << '\n'; } std::cout << n << ' ' << t << '\n'; }`, { stdin: 'um\n\ntres com espaço\nsem fim', stdout: '1:um\n2:\n3:tres com espaço\n4:sem fim\n4 25\n' })
c('getchar-crlf', R`#include <stdio.h>
int main(void) { int c, n = 0, r = 0; while ((c = getchar()) != EOF) { n++; if (c == '\r') r++; } printf("%d %d\n", n, r); return 0; }`, { stdin: 'a\r\nb\r\n', stdout: '6 2\n' })
c('stdin-1mb', R`#include <stdio.h>
int main(void) { int x; long s = 0, n = 0; while (scanf("%d", &x) == 1) { s += x; n++; } printf("%ld %ld\n", n, s); return 0; }`, { stdin: '7\n'.repeat(524288), stdout: '524288 3670016\n' })
cpp('cin-1mb', R`#include <iostream>
#include <string>
int main() { std::ios::sync_with_stdio(false); std::string s; long n = 0, t = 0; while (std::cin >> s) { n++; t += s.size(); } std::cout << n << ' ' << t << '\n'; }`, { stdin: 'abc\n'.repeat(262144), stdout: '262144 786432\n' })
c('stdin-5mb-fread', R`#include <stdio.h>
static char b[65536];
int main(void) { long t = 0; size_t k; while ((k = fread(b, 1, sizeof b, stdin)) > 0) t += k; printf("%ld\n", t); return 0; }`, { stdin: 'x'.repeat(5 * 1024 * 1024), stdout: '5242880\n' })
c('sem-newline', R`#include <stdio.h>
int main(void) { printf("sem quebra de linha"); return 0; }`, { stdout: 'sem quebra de linha' })
cpp('sem-newline-cout', R`#include <iostream>
int main() { std::cout << "resultado: " << 42; }`, { stdout: 'resultado: 42' })
c('sem-newline-exit', R`#include <stdio.h>
#include <stdlib.h>
int main(void) { printf("parcial"); exit(4); }`, { stdout: 'parcial', exit: 4 })
c('ordem-linhas', R`#include <stdio.h>
int main(void) { printf("1\n"); fprintf(stderr, "2\n"); printf("3\n"); fprintf(stderr, "4\n"); return 0; }`, { merged: '1\n2\n3\n4\n', stdout: '1\n3\n', stderr: '2\n4\n' })
c('ordem-sem-newline', R`#include <stdio.h>
int main(void) { printf("a"); fprintf(stderr, "b\n"); printf("c\n"); return 0; }`, { merged: 'b\nac\n', note: 'stdout é por linha, stderr sem buffer: mesma ordem de um terminal real.' })
c('ordem-fflush', R`#include <stdio.h>
int main(void) { printf("a"); fflush(stdout); fprintf(stderr, "b"); printf("c"); fflush(stdout); fprintf(stderr, "d"); return 0; }`, { merged: 'abcd' })
cpp('ordem-cout-cerr', R`#include <iostream>
int main() { std::cout << "a\n" << std::flush; std::cerr << "b\n"; std::cout << "c" << std::endl; std::clog << "d\n"; }`, { merged: 'a\nb\nc\nd\n' })
c('utf8-fonte', R`#include <stdio.h>
#include <string.h>
int main(void) { printf("ação é ñ 日本語 😀 %zu\n", strlen("é")); return 0; }`, { stdout: 'ação é ñ 日本語 😀 2\n' })
c('utf8-stdin', R`#include <stdio.h>
int main(void) { char b[128]; while (fgets(b, sizeof b, stdin)) fputs(b, stdout); return 0; }`, { stdin: 'coração\n😀 maçã\n', stdout: 'coração\n😀 maçã\n' })
cpp('utf8-cin', R`#include <iostream>
#include <string>
int main() { std::string s; std::cin >> s; std::cout << s << ' ' << s.size() << '\n'; }`, { stdin: 'João', stdout: 'João 5\n' })
c('utf8-byte-a-byte', R`#include <stdio.h>
int main(void) { setvbuf(stdout, NULL, _IONBF, 0); const char *s = "é😀日"; for (; *s; s++) putchar(*s); return 0; }`, { stdout: 'é😀日' })
c('utf8-byte-a-byte-stderr', R`#include <stdio.h>
int main(void) { const char *s = "ção😀"; for (; *s; s++) fputc(*s, stderr); return 0; }`, { stderr: 'ção😀' })
c('utf8-streams-separados', R`#include <stdio.h>
int main(void) { setvbuf(stdout, NULL, _IONBF, 0); putchar(0xC3); fputc(0xC3, stderr); putchar(0xA9); fputc(0xA7, stderr); return 0; }`, { stdout: 'é', stderr: 'ç' })
c('utf8-fronteira-buffer', R`#include <stdio.h>
int main(void) { static char b[8192]; setvbuf(stdout, b, _IOFBF, sizeof b); putchar('x'); for (int i = 0; i < 20000; i++) fputs("é", stdout); return 0; }`, { check: (o) => (o.run?.stdout === 'x' + 'é'.repeat(20000) ? null : 'blocos de 8 KiB partiram o é') })
c('utf8-truncado-no-fim', R`#include <stdio.h>
int main(void) { printf("ok"); putchar(0xC3); return 0; }`, { stdout: 'ok�' })
c('bytes-invalidos', R`#include <stdio.h>
int main(void) { fwrite("a\xFF\x80z", 1, 4, stdout); return 0; }`, { stdout: 'a��z' })
c('byte-nulo', R`#include <stdio.h>
int main(void) { fwrite("a\0b", 1, 3, stdout); return 0; }`, { stdout: 'a\0b' })
c('stdin-byte-nulo', R`#include <stdio.h>
int main(void) { int c, n = 0, z = 0; while ((c = getchar()) != EOF) { n++; if (!c) z++; } printf("%d %d\n", n, z); return 0; }`, { stdin: 'a\0b\0', stdout: '4 2\n' })
c('exit-3', R`int main(void) { return 3; }`, { exit: 3, stdout: '' })
c('exit-7', R`#include <stdio.h>
#include <stdlib.h>
int main(void) { puts("x"); exit(7); }`, { exit: 7, stdout: 'x\n' })
c('exit-0-sem-return', R`int main(void) { }`, { exit: 0, stdout: '' })
c('exit-300', R`int main(void) { return 300; }`, { exit: 44, note: 'POSIX: o código de saída é módulo 256.' })
c('exit-negativo', R`int main(void) { return -1; }`, { exit: 255 })
c('underscore-exit', R`#include <stdio.h>
#include <stdlib.h>
int main(void) { printf("x\ny"); _Exit(5); }`, { exit: 5, stdout: 'x\n' })
c('atexit', R`#include <stdio.h>
#include <stdlib.h>
void bye(void) { puts("tchau"); }
int main(void) { atexit(bye); puts("oi"); return 0; }`, { stdout: 'oi\ntchau\n' })
c('argv', R`#include <stdio.h>
int main(int argc, char **argv) { printf("%d %s\n", argc, argv[0]); return 0; }`, { stdout: '1 main\n' })
c('saida-100k-linhas', R`#include <stdio.h>
int main(void) { for (int i = 0; i < 100000; i++) printf("%d\n", i); return 0; }`, { check: (o) => (o.run?.stdout.endsWith('99999\n') && o.run.stdout.split('\n').length === 100001 ? null : 'faltaram linhas'), maxLagMs: 1500 })

// ------------------------------------------------------------------ falhas contidas
group = 'crash'
c('laco-infinito', R`int main(void) { volatile int x = 1; while (x) { } return 0; }`, { timedOut: true, exit: -1, error: /Passou de/, timeoutMs: 1500 })
c('laco-infinito-parcial', R`#include <stdio.h>
int main(void) { puts("antes"); volatile int x = 1; while (x) { } return 0; }`, { timedOut: true, stdout: 'antes\n', timeoutMs: 1500 })
c('laco-com-saida', R`#include <stdio.h>
int main(void) { for (;;) puts("0123456789"); return 0; }`, {
  timedOut: false, error: /1 MB/,
  check: (o) => { const n = o.run?.stdout.length ?? 0; return n > 1024 * 1024 - 8192 && n <= 1024 * 1024 ? null : `stdout com ${n} bytes, deveria parar perto de 1 MiB` },
})
c('saida-gigante-um-write', R`#include <stdio.h>
#include <string.h>
static char b[3000000];
int main(void) { memset(b, 'x', sizeof b); fwrite(b, 1, sizeof b, stdout); return 0; }`, { error: /1 MB/, check: (o) => (o.run?.stdout.length === 1024 * 1024 ? null : `recebeu ${o.run?.stdout.length} bytes, deveria receber o limite inteiro`) })
c('saida-stderr-flood', R`#include <stdio.h>
int main(void) { for (;;) fputc('x', stderr); return 0; }`, {
  error: /1 MB/, maxLagMs: 1500, harnessMs: 120_000,
  check: (o) => { const n = o.run?.stderr.length ?? 0; return n > 0 && n <= 1024 * 1024 ? null : `stderr com ${n} bytes` },
  note: 'pior caso de postMessage: uma mensagem por byte.',
})
c('saida-dois-streams', R`#include <stdio.h>
int main(void) { for (;;) { puts("aaaaaaaaaaaaaaa"); fputs("bbbbbbbbbbbbbbb\n", stderr); } return 0; }`, { error: /1 MB/, check: (o) => ((o.run?.stdout.length ?? 0) + (o.run?.stderr.length ?? 0) <= 1024 * 1024 ? null : 'limite não é somado entre stdout e stderr') })
c('recursao-infinita', R`#include <stdio.h>
volatile int sink;
int f(int n) { char b[64]; b[n % 64] = n; sink = b[(n + 1) % 64]; return f(n + 1) + sink; }
int main(void) { printf("%d\n", f(0)); return 0; }`, { error: STACK, exit: 139 })
c('recursao-infinita-pequena', R`#include <stdio.h>
__attribute__((noinline)) void toca(volatile int *p) { *p = 1; }
int f(int n) { int a = n; toca(&a); return f(n + 1) + a; }
int main(void) { printf("%d\n", f(0)); return 0; }`, { error: STACK, exit: 139 })
c('recursao-quadro-grande', R`#include <stdio.h>
#include <string.h>
int f(int n) { char b[65536]; memset(b, n, sizeof b); return f(n + 1) + b[n % 65536]; }
int main(void) { printf("%d\n", f(0)); return 0; }`, { error: STACK, exit: 139 })
c('recursao-otimizavel', R`#include <stdio.h>
int f(int n) { return f(n + 1); }
int main(void) { printf("%d\n", f(0)); return 0; }`, {
  timeoutMs: 1500, anyExit: true, check: ran,
  note: 'em -O1 a recursão de cauda vira laço (ou some, por ser UB): o aluno pode ver tempo esgotado em vez de estouro de pilha.',
})
c('pilha-corrompe-globais', R`#include <stdio.h>
#include <string.h>
int canario = 12345;
char dados[64] = "intacto";
int f(int n) { char b[4096]; memset(b, 0xAA, sizeof b); return n == 0 ? b[5] : f(n - 1) + b[n % 4096]; }
int main(int argc, char **argv) { int r = f(5000 + argc); printf("%d %s %d\n", canario, dados, r != 0); return 0; }`, { error: STACK, exit: 139, stdout: '', note: 'com a pilha antes dos dados o estouro bate fora da memória, em vez de sobrescrever globais em silêncio.' })
c('array-local-enorme', R`#include <stdio.h>
__attribute__((noinline)) void preenche(int *a, int n) { for (int i = 0; i < n; i++) a[i] = i; }
int main(void) { int a[4000000]; preenche(a, 4000000); printf("%d\n", a[3999999]); return 0; }`, { error: STACK, exit: 139, note: '16 MB na pilha de 8 MB, erro clássico de iniciante.' })
c('deref-nulo-volatil', R`#include <stdio.h>
int main(void) { volatile int *p = 0; *p = 5; printf("%d\n", *p); return 0; }`, {
  error: MEM, exit: 139,
  knownLimit: { reason: 'A memória linear do wasm não protege o endereço 0: ler ou escrever por NULL funciona em silêncio. Programa com bug de ponteiro nulo pode até passar nos testes, embora quebrasse no gcc.', actual: { stdout: '5\n', exit: 0, error: null } },
})
c('deref-nulo-direto', R`#include <stdio.h>
int main(void) { int *p = NULL; *p = 1; puts("sobreviveu"); return 0; }`, {
  anyExit: true, check: ran,
  note: 'em -O1 NULL constante é UB: o clang pode gerar trap ou nada.',
})
c('lista-nula', R`#include <stdio.h>
struct No { int v; struct No *prox; };
int soma(struct No *p) { int s = 0; while (p->prox) { s += p->v; p = p->prox; } return s + p->v; }
int main(int argc, char **argv) { struct No *n = argc > 5 ? (struct No *)argv : 0; printf("%d\n", soma(n)); return 0; }`, {
  error: MEM,
  knownLimit: { reason: 'Mesmo motivo do NULL: percorrer lista nula lê lixo sem falhar.', actual: { anyExit: true, check: ran } },
})
c('ponteiro-selvagem', R`#include <stdio.h>
int main(void) { volatile int *p = (int *)0x7ffffff0; *p = 1; puts("nao"); return 0; }`, { error: MEM, exit: 139, stdout: '' })
c('ponteiro-negativo', R`#include <stdio.h>
int main(void) { volatile int v[4] = {0}; volatile int i = -2000000000; printf("%d\n", v[i]); return 0; }`, { error: MEM, exit: 139 })
c('indice-fora-pequeno', R`#include <stdio.h>
int main(void) { int v[4] = {1, 2, 3, 4}; volatile int i = 100; v[i] = 7; printf("%d\n", v[i]); return 0; }`, {
  error: MEM,
  knownLimit: { reason: 'Fora do vetor mas dentro da memória linear: sem trap, igual a C nativo na maioria dos casos.', actual: { stdout: '7\n', exit: 0 } },
})
c('div-zero-int', R`#include <stdio.h>
int main(void) { volatile int a = 7, z = 0; printf("%d\n", a / z); return 0; }`, { error: /Divis[aã]o por zero/, exit: 139, stdout: '' })
c('div-zero-numerador-1', R`#include <stdio.h>
int main(void) { volatile int z = 0; printf("%d\n", 1 / z); return 0; }`, {
  error: /Divis[aã]o por zero/, exit: 139,
  knownLimit: { reason: 'Em -O1 o clang transforma 1 / z em z == 1 ? 1 : 0, porque dividir por zero é UB: imprime 0, sem crash. Só acontece com numerador constante 1.', actual: { stdout: '0\n', exit: 0 } },
})
c('mod-zero-int', R`#include <stdio.h>
int main(void) { volatile int a = 7, z = 0; printf("%d\n", a % z); return 0; }`, { error: /Divis[aã]o por zero/, exit: 139 })
c('div-int-min', R`#include <limits.h>
#include <stdio.h>
int main(void) { volatile int a = INT_MIN, b = -1; printf("%d\n", a / b); return 0; }`, { error: /Divis[aã]o|estouro/i, exit: 139 })
c('div-zero-float', R`#include <stdio.h>
int main(void) { volatile double z = 0; printf("%f %f %f\n", 1 / z, -1 / z, z / z); return 0; }`, { stdout: /^inf -inf -?nan\n$/, error: null })
c('float-para-int', R`#include <stdio.h>
int main(void) { volatile double d = 1e30; volatile int i = (int)d; printf("%d\n", i != 0); return 0; }`, { error: null, stdout: '1\n', note: 'UB em C, mas não pode virar trap sem explicação.' })
c('abort', R`#include <stdio.h>
#include <stdlib.h>
int main(void) { puts("antes"); abort(); }`, { error: ABORT, exit: 139, stdout: 'antes\n' })
c('abort-parcial', R`#include <stdio.h>
#include <stdlib.h>
int main(void) { printf("sem newline"); abort(); }`, { error: ABORT, stdout: 'sem newline', note: 'printf de depuração sem \\n antes do crash não pode sumir.' })
c('trap-parcial', R`#include <stdio.h>
int main(void) { printf("chegou aqui"); volatile int a = 7, z = 0; printf("%d", a / z); return 0; }`, { error: /Divis/, stdout: 'chegou aqui' })
c('assert-falha', R`#include <assert.h>
#include <stdio.h>
int main(void) { volatile int a = 1; assert(a == 2); puts("nao"); return 0; }`, { error: ABORT, exit: 139, stderr: /Assertion failed|a == 2/, stdout: '' })
cpp('throw-sem-catch', R`#include <iostream>
#include <stdexcept>
int main() { std::cout << "antes\n"; throw std::runtime_error("x"); }`, { error: ABORT, stdout: 'antes\n', stderr: EXC, exit: 139 })
cpp('throw-parcial', R`#include <iostream>
int main() { std::cout << "parcial"; throw 1; }`, { error: ABORT, stdout: 'parcial', stderr: EXC })
cpp('try-catch-compila', R`#include <iostream>
#include <stdexcept>
int f(int x) { if (x < 0) throw std::invalid_argument("neg"); return x; }
int main() { try { std::cout << f(2) << '\n'; } catch (const std::exception &e) { std::cout << e.what(); } catch (...) { std::cout << "?"; } }`, { stdout: '2\n' })
cpp('try-catch-pega', R`#include <iostream>
#include <stdexcept>
int main() { try { throw std::runtime_error("x"); } catch (const std::exception &e) { std::cout << "pegou " << e.what() << '\n'; } }`,
  { stdout: 'pegou x\n', knownLimit: { reason: NO_EXC + ' Questão que exige tratamento de exceção não roda.', actual: { error: ABORT, stderr: EXC, stdout: '' } } })
cpp('catch-rethrow', R`#include <exception>
#include <iostream>
#include <stdexcept>
int f(int x) { try { if (x > 100) throw std::runtime_error("a"); return x; } catch (const std::exception &e) { std::cout << e.what(); throw; } }
int main() { std::cout << f(1) << '\n'; try { f(1); } catch (...) { auto p = std::current_exception(); std::rethrow_exception(p); } }`, { stdout: '1\n' })
cpp('raii-throw', R`#include <iostream>
#include <memory>
#include <vector>
struct R { ~R() { std::cout << "d\n"; } };
void g(int x) { R r; std::vector<int> v(3); if (x) throw 1; std::cout << "g\n"; }
int main() { g(0); auto p = std::make_unique<R>(); g(1); }`, { stdout: 'g\nd\n', error: ABORT, stderr: EXC })
cpp('vector-at', R`#include <iostream>
#include <vector>
int main() { std::vector<int> v(2); std::cout << "a\n"; std::cout << v.at(5) << '\n'; }`, { error: ABORT, stdout: 'a\n', stderr: /.+/, exit: 139 })
cpp('vector-at-catch', R`#include <iostream>
#include <stdexcept>
#include <vector>
int main() { std::vector<int> v(2); try { v.at(5) = 1; } catch (const std::out_of_range &) { std::cout << "fora\n"; } }`,
  { stdout: 'fora\n', knownLimit: { reason: NO_EXC, actual: { error: ABORT } } })
cpp('vector-indice-fora', R`#include <iostream>
#include <vector>
int main() { std::vector<int> v(2); volatile int i = 100; v[i] = 1; std::cout << v[i] << '\n'; }`, { anyExit: true, check: ran, note: 'operator[] fora do limite: sem trap, igual ao nativo sem hardening.' })
cpp('stoi-invalido', R`#include <iostream>
#include <string>
int main() { std::cout << "a\n"; std::cout << std::stoi("abc") << '\n'; }`, { error: ABORT, stdout: 'a\n', stderr: /.+/ })
cpp('stoi-catch', R`#include <iostream>
#include <string>
int main() { try { std::cout << std::stoi("abc"); } catch (const std::invalid_argument &) { std::cout << "invalido\n"; } }`,
  { stdout: 'invalido\n', knownLimit: { reason: NO_EXC + ' Validar entrada com stoi + catch, comum em C++, encerra o programa.', actual: { error: ABORT } } })
cpp('optional-vazio', R`#include <iostream>
#include <optional>
int main() { std::optional<int> o; std::cout << o.value(); }`, { error: ABORT, exit: 139 })
cpp('variant-errado', R`#include <iostream>
#include <variant>
int main() { std::variant<int, double> v = 1; std::cout << std::get<double>(v); }`, { error: ABORT, exit: 139 })
cpp('terminate', R`#include <exception>
#include <iostream>
int main() { std::cout << "a\n"; std::terminate(); }`, { error: ABORT, stdout: 'a\n' })
cpp('metodo-virtual-puro', R`#include <iostream>
struct B { virtual void f() = 0; B() { g(); } void g() { f(); } };
struct D : B { void f() override { } };
int main() { D d; std::cout << "nao\n"; }`, { error: ABORT, exit: 139 })
c('ponteiro-funcao-nulo', R`#include <stdio.h>
int main(int argc, char **argv) { int (*volatile f)(void) = 0; puts("a"); printf("%d\n", f()); return argc; }`, { error: /fun[cç][aã]o/i, exit: 139, stdout: 'a\n' })
c('ponteiro-funcao-assinatura', R`#include <stdio.h>
int g(int a, int b) { return a + b; }
int main(void) { int (*volatile f)(void) = (int (*)(void))g; printf("%d\n", f()); return 0; }`, { error: /fun[cç][aã]o/i, exit: 139 })
// volatile impede o otimizador de apagar a alocação: sem ele o laço vira infinito
c('malloc-bomba', R`#include <stdio.h>
#include <stdlib.h>
#include <string.h>
void *volatile g;
int main(void) { long t = 0; for (;;) { char *p = malloc(1 << 20); g = p; if (!p) break; memset(p, 1, 1 << 20); t++; } printf("%ld %d\n", t, (int)__builtin_wasm_memory_size(0) / 16); return 0; }`, {
  exit: 0, error: null,
  check: (o) => { const m = o.run?.stdout.match(/^(\d+) (\d+)\n$/); if (!m) return `stdout ${o.run?.stdout}`; return +m[1] > 200 && +m[1] <= 256 && +m[2] <= 256 ? null : `alocou ${m[1]} MB, memória ${m[2]} MB` },
})
c('malloc-bomba-pequena', R`#include <stdio.h>
#include <stdlib.h>
void *volatile g;
int main(void) { long t = 0; for (;;) { char *p = malloc(4096); g = p; if (!p) break; *p = 1; t++; } printf("%d %d\n", t * 4096 > 200000000, __builtin_wasm_memory_size(0) <= 4096); return 0; }`, { stdout: '1 1\n', exit: 0, timeoutMs: 30_000, note: 'cada memory.grow custa perto de 1 ms no navegador: com o limite de 5 s esta bomba cai por tempo antes de esgotar a memória.' })
c('malloc-gigante', R`#include <stdio.h>
#include <stdlib.h>
int main(void) { void *volatile a = malloc(300u * 1024 * 1024); void *volatile b = malloc(0xFFFFFFF0u); void *volatile c = malloc(255u * 1024 * 1024); printf("%d %d %d\n", a == NULL, b == NULL, c == NULL); return 0; }`, { stdout: '1 1 1\n', note: 'malloc de 255 MB falha porque pilha e dados já ocupam parte dos 256 MB.' })
c('memory-grow-direto', R`#include <stdio.h>
int main(void) { int a = __builtin_wasm_memory_grow(0, 65536); int b = __builtin_wasm_memory_grow(0, 4097); int t = 0; while (__builtin_wasm_memory_grow(0, 1) != -1) t++; int c = __builtin_wasm_memory_size(0); int d = __builtin_wasm_memory_grow(0, 1); printf("%d %d %d %d\n", a, b, c, d); return t < 0; }`, {
  stdout: '-1 -1 4096 -1\n', exit: 0, note: 'memory.grow direto, sem passar por malloc: para exatamente em 4096 páginas (256 MiB).',
})
c('estouro-limite-escrita', R`#include <stdio.h>
int main(void) { while (__builtin_wasm_memory_grow(0, 1) != -1) { } volatile char *p = (char *)(256u * 1024 * 1024 - 1); *p = 1; puts("ultimo byte ok"); fflush(stdout); volatile char *q = (char *)(256u * 1024 * 1024); *q = 1; puts("nao"); return 0; }`, { stdout: 'ultimo byte ok\n', error: MEM, exit: 139 })
cpp('new-bomba', R`#include <iostream>
char *volatile g;
int main() { for (;;) { g = new char[1 << 20]; g[0] = 1; } }`, { error: ABORT, exit: 139, stdout: '', note: 'new sem memória não lança bad_alloc: encerra o programa.' })
cpp('new-nothrow', R`#include <iostream>
#include <new>
char *volatile g;
int main() { long t = 0; for (;;) { g = new (std::nothrow) char[1 << 20]; if (!g) break; g[0] = 1; t++; } std::cout << (t > 200 && t <= 256) << '\n'; }`, { stdout: '1\n' })
cpp('new-bad-alloc-catch', R`#include <iostream>
#include <new>
char *volatile g;
int main() { try { for (;;) { g = new char[1 << 20]; g[0] = 1; } } catch (const std::bad_alloc &) { std::cout << "sem memoria\n"; } }`,
  { stdout: 'sem memoria\n', knownLimit: { reason: NO_EXC, actual: { error: ABORT } } })
cpp('vector-bomba', R`#include <iostream>
#include <vector>
int main() { std::vector<int> v; for (;;) v.push_back(1); }`, { error: ABORT, exit: 139 })
cpp('string-bomba', R`#include <iostream>
#include <string>
int main() { std::string s = "x"; for (;;) s += s; }`, { error: ABORT, exit: 139 })
cpp('vector-tamanho-negativo', R`#include <iostream>
#include <vector>
int main() { volatile int n = -1; std::vector<int> v(n); std::cout << v.size(); }`, { error: ABORT, exit: 139 })
c('array-estatico-enorme', R`#include <stdio.h>
static char a[300 * 1024 * 1024];
char *volatile p = a;
int main(void) { p[5] = 1; printf("%d\n", p[5]); return 0; }`, { compile: 'error', internal: false, log: /memory|too large|maximum/i, note: 'o linker recusa: não passa do limite nem por dados estáticos.' })
c('array-estatico-grande-ok', R`#include <stdio.h>
#include <string.h>
static char a[200 * 1024 * 1024];
char *volatile p = a;
int main(void) { memset(p, 1, sizeof a); printf("%d\n", p[sizeof a - 1]); return 0; }`, { stdout: '1\n', maxCompileMs: 20_000 })
c('global-4mb-compila-rapido', R`#include <stdio.h>
int dp[1000001];
int main(void) { dp[1000000] = 7; printf("%d\n", dp[1000000]); return 0; }`, { stdout: '7\n', maxCompileMs: 6000, note: 'int dp[1000001], o global mais comum em exercício: sem LTO custava mais de 4 s de compilação.' })
c('global-64mb-compila-rapido', R`#include <stdio.h>
int dp[16000000];
int volatile i = 15999999;
int main(void) { dp[i] = 7; printf("%d\n", dp[i]); return 0; }`, { stdout: '7\n', maxCompileMs: 10_000 })
cpp('global-cpp-16mb-compila-rapido', R`#include <iostream>
long long dp[2000000];
int main() { dp[1999999] = 7; std::cout << dp[1999999] << '\n'; }`, { stdout: '7\n', maxCompileMs: 30_000 })
c('array-global-int', R`#include <stdio.h>
int a[100000000];
int volatile i = 99999999;
int main(void) { a[i] = 1; printf("%d\n", a[i]); return 0; }`, { compile: 'error', internal: false, log: /memory|too large|maximum/i, note: '400 MB globais: erro de link, sem crash.' })
c('double-free', R`#include <stdio.h>
#include <stdlib.h>
int main(void) { char *volatile p = malloc(32); free(p); free(p); puts("sobreviveu"); return 0; }`, {
  anyExit: true, check: ran, note: 'dlmalloc: comportamento real anotado no relatório.',
})
c('use-after-free', R`#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void) { char *volatile p = malloc(32); strcpy(p, "abc"); free(p); printf("%d\n", p[10] == 0 || 1); char *volatile q = malloc(32); strcpy(q, "novo"); printf("%d %s\n", p == q, p); return 0; }`, {
  stdout: '1\n1 novo\n', error: null, note: 'sem trap, igual ao nativo: o ponteiro velho aliasa a alocação nova.',
})
c('heap-corrompido', R`#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void) { char *volatile a = malloc(16); char *volatile b = malloc(16); memset(a, 0xFF, 4096); free(b); free(a); char *volatile c = malloc(64); puts(c ? "fim" : "null"); return 0; }`, {
  anyExit: true, check: ran, note: 'heap corrompido pode dar trap ou passar; o que importa é não derrubar o host.',
})
scenario('memoria-maxima-no-binario', async ({ mustCompile }) => {
  const pages = (w: Uint8Array) => {
    // Lê a seção de memória do wasm: o limite tem de estar no binário, não só no combinado.
    const leb = (p: number): [number, number] => { let v = 0, s = 0, b = 0; do { b = w[p++]; v += (b & 127) * 2 ** s; s += 7 } while (b & 128); return [v, p] }
    let p = 8
    while (p < w.length) {
      const id = w[p++]
      let n
      ;[n, p] = leb(p)
      if (id === 5) {
        let q = p, count, flags, min, max
        ;[count, q] = leb(q)
        flags = w[q++]
        ;[min, q] = leb(q)
        if (flags & 1) [max, q] = leb(q)
        return { count, flags, min, max }
      }
      p += n
    }
    return null
  }
  const failures: string[] = []
  const a = pages(await mustCompile('c', 'int main(void) { return 0; }'))
  const b = pages(await mustCompile('cpp', '#include <vector>\nint main() { std::vector<int> v(1); return v[0]; }'))
  for (const m of [a, b]) if (!m || m.max !== RUN_LIMITS.memoryMb * 16) failures.push(`seção de memória: ${JSON.stringify(m)}`)
  return { failures, metrics: { c: a, cpp: b } }
}, { harnessMs: 60_000 })
// Profundidade máxima real: a pilha da VM do worker é menor que os 8 MB da pilha do programa.
scenario('recursao-profundidade-maxima', async ({ mustCompile, run }) => {
  const programs = {
    pequena: R`#include <stdio.h>
__attribute__((noinline)) void toca(volatile int *p) { *p = 1; }
int f(int n) { int a = n; toca(&a); if (n == 0) return 0; return f(n - 1) + a - n + 1; }
int main(void) { int n; scanf("%d", &n); printf("%d\n", f(n)); return 0; }`,
    quatroArgs: R`#include <stdio.h>
__attribute__((noinline)) void toca(volatile long long *p) { *p = 1; }
long long f(int n, long long a, long long b, long long c) { long long d = a + b; toca(&d); if (n == 0) return c; return f(n - 1, b, a, c + 1) + d - a - b - 1; }
int main(void) { int n; scanf("%d", &n); printf("%lld\n", f(n, 0, 0, 0) != 12345); return 0; }`,
    local1k: R`#include <stdio.h>
__attribute__((noinline)) void toca(volatile char *p) { p[0] = 1; }
int f(int n) { char b[1024]; toca(b); if (n == 0) return 0; return f(n - 1) + b[0]; }
int main(void) { int n; scanf("%d", &n); printf("%d\n", f(n) != -1); return 0; }`,
  }
  const metrics: Record<string, unknown> = {}
  const failures: string[] = []
  for (const [name, src] of Object.entries(programs)) {
    const wasm = await mustCompile('c', src)
    const ok = async (n: number) => { const r = await run(wasm, String(n), 15_000); return r.exitCode === 0 && !r.error }
    let lo = 500, hi = 4_000_000
    if (!(await ok(lo))) failures.push(`${name}: não aguenta ${lo} níveis`)
    while (hi - lo > lo * 0.02) {
      const mid = Math.round((lo + hi) / 2)
      if (await ok(mid)) lo = mid
      else hi = mid
    }
    metrics[name] = lo
  }
  return { failures, metrics, notes: [`profundidade máxima: ${JSON.stringify(metrics)}`] }
}, { harnessMs: 300_000 })
c('recursao-legitima-5k', R`#include <stdio.h>
int v[5001];
__attribute__((noinline)) void toca(volatile int *p) { *p = 1; }
int dfs(int n) { int a = n; toca(&a); if (n == 0) return 0; v[n] = dfs(n - 1) + 1; return v[n]; }
int main(void) { printf("%d\n", dfs(5000)); return 0; }`, { stdout: '5000\n' })
c('recursao-legitima-100k', R`#include <stdio.h>
int v[100001];
__attribute__((noinline)) void toca(volatile int *p) { *p = 1; }
int dfs(int n) { int a = n; toca(&a); if (n == 0) return 0; v[n] = dfs(n - 1) + 1; return v[n]; }
int main(void) { printf("%d\n", dfs(100000)); return 0; }`, { stdout: '100000\n', knownLimit: { reason: 'A pilha de um worker do navegador tem cerca de 500 KB, sem como aumentar: a recursão morre perto de 8 mil níveis (4 mil com mais argumentos), onde o nativo aguentaria mais de 100 mil. DFS em grafo grande dá estouro de pilha só aqui.', actual: { error: STACK, exit: 139 } } })
c('recursao-legitima-10k', R`#include <stdio.h>
int v[10001];
__attribute__((noinline)) void toca(volatile int *p) { *p = 1; }
int dfs(int n) { int a = n; toca(&a); if (n == 0) return 0; v[n] = dfs(n - 1) + 1; return v[n]; }
int main(void) { printf("%d\n", dfs(10000)); return 0; }`, { stdout: '10000\n', knownLimit: { reason: 'Mesma pilha curta do worker: 10 mil níveis já não cabem.', actual: { error: STACK, exit: 139 } } })

// ---------------------------------------------------------- lado do compilador
group = 'compile'
const expBomb = R`#if __INCLUDE_LEVEL__ < 40
#include "main.c"
#include "main.c"
#endif
int main(void) { return 0; }
`
cpp('template-recursivo', R`template <int N> struct F { static const int v = F<N + 1>::v; };
int main() { return F<0>::v; }`, { compile: 'error', internal: false, log: /recursive template instantiation|template instantiation depth/i, diags: [{ file: 'main.cpp', line: 1, severity: 'error' }], knownLimit: { reason: 'A pilha curta do worker estoura antes do limite de 1024 níveis do clang. O aluno vê uma mensagem de código aninhado demais, em vez do diagnóstico do clang.', actual: { compile: 'error', internal: false, log: /aninhado demais/ } } })
cpp('constexpr-infinito', R`constexpr int f() { int i = 0; for (;;) i++; return i; }
constexpr int x = f();
int main() { return x; }`, { compile: 'error', internal: false, log: /constexpr|constant expression/ })
c('include-recursivo', R`#include "main.c"
int main(void) { return 0; }`, { compile: 'error', internal: false, log: /nested too deeply/ })
multi('include-mutuo', 'c', { 'main.c': '#include "a.h"\nint main(void) { return 0; }', 'a.h': '#include "b.h"', 'b.h': '#include "a.h"' }, { compile: 'error', internal: false, log: /nested too deeply/ })
c('fonte-grande-200k', 'int main(void) { return 0; }\n' + Array.from({ length: 6000 }, (_, i) => `int f${i}(int x) { return x + ${i}; }`).join('\n'), { exit: 0, harnessMs: 90_000, note: 'perto do limite de 256 KiB do protocolo.' })
c('fonte-5mb-comentario', 'int main(void) { return 0; }\n// ' + 'x'.repeat(5 * 1024 * 1024) + '\n', { exit: 0, harnessMs: 90_000 })
c('array-init-1mb', '#include <stdio.h>\nint v[] = {' + '7,'.repeat(500000) + '};\nint main(void) { printf("%zu %d\\n", sizeof v / sizeof *v, v[499999]); return 0; }\n', { stdout: '500000 7\n', harnessMs: 90_000 })
c('passwd', R`#include "/etc/passwd"
int main(void) { return 0; }`, { compile: 'error', internal: false, diags: [{ file: 'main.c', line: 1, severity: 'error', message: /not found/ }] })
c('include-ausente', R`#include "nao_existe.h"
int main(void) { return 0; }`, { compile: 'error', internal: false, diags: [{ file: 'main.c', line: 1, column: 10, severity: 'error', message: /nao_existe\.h.*not found/ }] })
c('include-absoluto-sistema', R`#include "/usr/include/stdio.h"
int main(void) { return 0; }`, { anyCompile: true, anyExit: true, check: (o) => (o.compile.ok === true || (o.compile.ok === false && !o.compile.internal) ? null : 'erro interno'), note: 'o /usr é o sysroot virtual em memória: nada do disco real.' })
multi('diag-header', 'c', {
  'main.c': '#include "util.h"\nint main(void) {\n  return soma(1, 2)\n}\n',
  'util.h': 'int soma(int a, int b);\nint quebrado(;\n',
}, {
  compile: 'error', internal: false,
  diags: [
    { file: 'util.h', line: 2, column: 14, severity: 'error' },
    { file: 'main.c', line: 3, column: 20, severity: 'error', message: /expected ';'/ },
  ],
})
multi('diag-segundo-arquivo', 'c', {
  'main.c': 'int soma(int a, int b);\nint main(void) { return soma(1, 2); }\n',
  'util.c': 'int soma(int a, int b) {\n  int x = 1;\n    return a + c;\n}\n',
}, { compile: 'error', internal: false, diags: [{ file: 'util.c', line: 3, column: 16, severity: 'error', message: /undeclared/ }] })
multi('diag-todos-os-arquivos', 'c', {
  'main.c': 'int main(void) {\n  return x;\n}\n',
  'util.c': 'int f(void) {\n  return y;\n}\n',
}, {
  compile: 'error', internal: false,
  diags: [{ file: 'main.c', line: 2, severity: 'error' }, { file: 'util.c', line: 2, severity: 'error' }],
  knownLimit: { reason: 'O @yowasp/clang para no primeiro arquivo com erro: gcc mostraria os dois. O aluno corrige um arquivo e só então vê os erros do seguinte.', actual: { compile: 'error', diags: [{ file: 'main.c', line: 2, severity: 'error' }] } },
})
c('diag-crlf', '#include <stdio.h>\r\nint main(void) {\r\n  int x\r\n  return 0;\r\n}\r\n', { compile: 'error', diags: [{ file: 'main.c', line: 3, column: 8, severity: 'error' }] })
c('diag-acento', R`int main(void) { int ação = 1; return açao; }`, { compile: 'error', diags: [{ file: 'main.c', line: 1, severity: 'error', message: /açao/ }], logNot: /�/ })
c('warning-sucesso', R`#include <stdio.h>
int main(void) {
  int nao_usado;
  int y;
  printf("%d\n", y);
  return 0;
}`, { exit: 0, diags: [{ file: 'main.c', line: 3, severity: 'warning', message: /unused/ }, { file: 'main.c', line: 5, severity: 'warning', message: /uninitialized/ }] })
c('note-parse', R`int f(int a);
int f(int a, int b);
int main(void) { return 0; }`, { compile: 'error', diags: [{ file: 'main.c', line: 2, severity: 'error' }, { file: 'main.c', line: 1, severity: 'note' }] })
c('sem-main', R`int f(void) { return 0; }`, { compile: 'error', internal: false, log: /int main\(\)/ })
cpp('sem-main-cpp', R`int f() { return 0; }`, { compile: 'error', internal: false, log: /main/ })
c('undefined-function', R`void nao_existe(void);
int main(void) { nao_existe(); return 0; }`, { compile: 'error', internal: false, log: /undefined symbol: nao_existe/ })
c('implicit-function', R`int main(void) { printff("x"); return 0; }`, { compile: 'error', internal: false, diags: [{ file: 'main.c', line: 1, column: 18, severity: 'error' }] })
c('gets-removido', R`#include <stdio.h>
int main(void) { char b[8]; gets(b); puts(b); return 0; }`, { compile: 'error', internal: false, log: /gets/ })
c('identificador-unicode', R`#include <stdio.h>
int main(void) { int ação = 3; double π = 3.5; printf("%d %.1f\n", ação, π); return 0; }`, { stdout: '3 3.5\n' })
cpp('identificador-unicode-cpp', R`#include <iostream>
int main() { int coração = 3; std::cout << coração << '\n'; }`, { stdout: '3\n' })
c('arquivo-vazio', '', { compile: 'error', internal: false, log: /main/ })
cpp('arquivo-vazio-cpp', '', { compile: 'error', internal: false, log: /main/ })
c('so-espacos', '   \n\n  \t\n', { compile: 'error', internal: false, log: /main/ })
c('bom-utf8', '﻿#include <stdio.h>\nint main(void) { puts("bom"); return 0; }\n', { stdout: 'bom\n' })
c('byte-nulo-fonte', '#include <stdio.h>\nint main(void) { puts("a"); return 0; }\n\0\n', { stdout: 'a\n', log: /null character/ })
c('linha-enorme', `int main(void) { int x = ${'1+'.repeat(20000)}1; return x != 20001; }`, { exit: 0, harnessMs: 90_000, knownLimit: { reason: 'Expressão com 20 mil termos estoura a pilha do worker dentro do clang.', actual: { compile: 'error', internal: false, log: /aninhado demais/ } } })
c('aninhamento-profundo', `int main(void) { return ${'('.repeat(20000)}0${')'.repeat(20000)}; }`, { compile: 'error', internal: false, harnessMs: 90_000, log: /bracket nesting|aninhado demais/i })
multi('so-header', 'c', { 'util.h': 'int x;' }, { compile: 'error', internal: false, log: /no input files|main/ })
cpp('tipo-exponencial', R`#include <utility>
template <class T> struct W { using A = std::pair<T, T>; using N = typename W<A>::N; };
template <> struct W<void> { using N = int; };
int main() { W<int>::N x; return 0; }`, { compile: 'error', internal: false, harnessMs: 180_000, note: 'tipo que dobra a cada nível: bate no limite de templates ou no watchdog, nunca trava.' })
c('macro-bomba-memoria', `#define A0 x,x,x,x,x,x,x,x
${Array.from({ length: 11 }, (_, i) => `#define A${i + 1} A${i},A${i},A${i},A${i},A${i},A${i},A${i},A${i}`).join('\n')}
int x; int v[] = { A11 };
int main(void) { return 0; }
`, { compile: 'error', harnessMs: 180_000, log: /.+/, note: 'expansão de 8^12 tokens: sem memória no compilador ou watchdog; a aba precisa sobreviver.' })

// Até onde a pilha curta do worker deixa o clang ir, em código que alguém escreveria de verdade.
scenario('limites-do-compilador', async ({ compile }) => {
  const shapes: Record<string, [(n: number) => Parameters<typeof compile>, number, number]> = {
    templateProfundidade: [(n) => ['cpp', { 'main.cpp': `template <int N> struct F { static const int v = F<N - 1>::v + 1; };\ntemplate <> struct F<0> { static const int v = 0; };\nint main() { return F<${n}>::v != ${n}; }\n` }], 8, 1024],
    parenteses: [(n) => ['c', { 'main.c': `int main(void) { return ${'('.repeat(n)}0${')'.repeat(n)}; }\n` }], 8, 250],
    blocos: [(n) => ['c', { 'main.c': `int main(void) { ${'if (1) { '.repeat(n)}${'}'.repeat(n)} return 0; }\n` }], 8, 250],
    somaTermos: [(n) => ['c', { 'main.c': `volatile int a = 1;\nint main(void) { return ${'a+'.repeat(n)}a != ${n + 1}; }\n` }], 64, 20000],
    elseIfCadeia: [(n) => ['c', { 'main.c': `volatile int a = 1;\nint main(void) { if (a == 0) return 1; ${Array.from({ length: n }, (_, i) => `else if (a == ${i + 2}) return 1;`).join(' ')} return 0; }\n` }], 16, 8000],
  }
  const metrics: Record<string, number> = {}
  const failures: string[] = []
  for (const [name, [mk, low, high]] of Object.entries(shapes)) {
    const ok = async (n: number) => (await compile(...mk(n))).ok
    let lo = low, hi = high
    if (!(await ok(lo))) failures.push(`${name}: não compila nem com ${lo}`)
    if (await ok(hi)) lo = hi
    while (hi - lo > Math.max(4, lo * 0.1)) {
      const mid = Math.round((lo + hi) / 2)
      if (await ok(mid)) lo = mid
      else hi = mid
    }
    metrics[name] = lo
  }
  return { failures, metrics, notes: [JSON.stringify(metrics)] }
}, { harnessMs: 400_000 })

// O watchdog só dispara num include exponencial real: 2^40 inclusões nunca terminam e não dão erro.
scenario('watchdog-60s', async ({ compile, parseDiagnostics }) => {
  const failures: string[] = []
  const t0 = performance.now()
  const bomb = compile('c', { 'main.c': expBomb })
  const after = compile('c', { 'main.c': '#include <stdio.h>\nint main(void) { puts("depois"); return 0; }\n' })
  let afterAt = 0
  after.then(() => { afterAt = performance.now() - t0 })
  const r = await bomb
  const ms = performance.now() - t0
  if (r.ok) failures.push('bomba compilou')
  else {
    if (!/60 s/.test(r.log)) failures.push(`mensagem do watchdog: ${r.log.slice(0, 200)}`)
    if (r.internal) failures.push('watchdog marcado como internal: session.ts reenviaria a bomba ao host')
    if (parseDiagnostics(r.log).length) failures.push('diagnóstico falso no log')
  }
  if (ms < 58_000 || ms > 75_000) failures.push(`watchdog em ${Math.round(ms)} ms`)
  const a = await after
  if (!a.ok) failures.push(`fila não continuou: ${a.log.slice(0, 200)}`)
  return { failures, metrics: { watchdogMs: Math.round(ms), filaDepoisMs: Math.round(afterAt - ms) } }
}, { harnessMs: 180_000 })

// ------------------------------------------------------------------- vários arquivos
group = 'multi'
const UTIL_H = '#ifndef UTIL_H\n#define UTIL_H\nint soma(int a, int b);\n#endif\n'
multi('c-tres-arquivos', 'c', { 'main.c': '#include <stdio.h>\n#include "util.h"\nint main(void) { printf("%d\\n", soma(2, 3)); return 0; }\n', 'util.c': '#include "util.h"\nint soma(int a, int b) { return a + b; }\n', 'util.h': UTIL_H }, { stdout: '5\n' })
multi('cpp-header-only', 'cpp', { 'main.cpp': '#include <iostream>\n#include "pilha.hpp"\nint main() { Pilha<int> p; p.push(3); std::cout << p.top() << "\\n"; }\n', 'pilha.hpp': '#pragma once\n#include <vector>\ntemplate <class T> struct Pilha { std::vector<T> v; void push(T x) { v.push_back(x); } T top() { return v.back(); } };\n' }, { stdout: '3\n' })
multi('cpp-varios', 'cpp', { 'main.cpp': '#include <iostream>\n#include "a.h"\n#include "b.h"\nint main() { std::cout << a() + b() << "\\n"; }\n', 'a.h': 'int a();\n', 'b.h': 'int b();\n', 'a.cpp': '#include "a.h"\n#include <string>\nint a() { return std::string("abc").size(); }\n', 'b.cc': '#include "b.h"\nint b() { return 4; }\n' }, { stdout: '7\n' })
multi('colisao-oblita-rt', 'cpp', { 'main.cpp': '#include <iostream>\nint f();\nint main() { std::cout << f() << "\\n"; }\n', 'oblita_rt.cpp': 'int f() { return 11; }\n' }, { stdout: '11\n' })
multi('colisao-oblita-rt-throw', 'cpp', { 'main.cpp': '#include <iostream>\nint f();\nint main() { std::cout << f() << "\\n"; throw 1; }\n', 'oblita_rt.cpp': 'int f() { return 11; }\n' }, { stdout: '11\n', error: ABORT, stderr: EXC })
cpp('redefine-cxa-throw', R`#include <cstdlib>
#include <iostream>
extern "C" void __cxa_throw(void *, void *, void (*)(void *)) { std::cout << "meu throw\n"; std::exit(9); }
int main() { throw 1; }`, { stdout: 'meu throw\n', exit: 9 })
cpp('redefine-cxa-alloc', R`#include <cstdlib>
#include <iostream>
extern "C" void *__cxa_allocate_exception(unsigned long n) { return std::malloc(n); }
extern "C" void __cxa_throw(void *, void *, void (*)(void *)) { std::cout << "meu throw\n"; std::exit(9); }
int main() { throw 1; }`, { stdout: 'meu throw\n', exit: 9 })
c('redefine-fflush', R`#include <stdlib.h>
int fflush(void *f) { return 42; }
int main(void) { return fflush(0) == 42 ? 5 : 6; }`, { exit: 5, note: 'o link exporta fflush: uma definição do aluno não pode colidir.' })
multi('simbolo-duplicado', 'c', { 'main.c': 'int f(void) { return 1; }\nint main(void) { return f(); }\n', 'b.c': 'int f(void) { return 2; }\n' }, { compile: 'error', internal: false, log: /duplicate symbol: f/ })
multi('main-duplicado', 'cpp', { 'a.cpp': 'int main() { return 0; }\n', 'b.cpp': 'int main() { return 1; }\n' }, { compile: 'error', internal: false, log: /duplicate symbol.*main/ })
multi('mesmo-radical', 'cpp', { 'a.cpp': 'int fa() { return 1; }\n', 'a.cc': 'int fb() { return 2; }\nint fa();\nint main() { return fa() + fb(); }\n' }, { exit: 3 })
multi('c-em-projeto-cpp', 'cpp', { 'main.cpp': '#include <iostream>\nint f();\nint main() { std::cout << f() << "\\n"; }\n', 'util.c': 'int f() { return 5; }\n' }, { stdout: '5\n', logNot: /deprecated/, note: 'igual ao g++: .c num projeto C++ compila como C++, sem o aviso de depreciação do clang++.' })
multi('c-guardado-em-projeto-cpp', 'cpp', { 'main.cpp': '#include <iostream>\nextern "C" int f();\nint main() { std::cout << f() << "\\n"; }\n', 'util.c': '#ifdef __cplusplus\nextern "C"\n#endif\nint f(void) { return 6; }\n' }, { stdout: '6\n' })
multi('c-puro-em-projeto-cpp', 'cpp', { 'main.cpp': 'extern "C" int f();\nint main() { return f(); }\n', 'util.c': '#include <stdlib.h>\nint f(void) { int *p = malloc(4); *p = 2; int r = *p; free(p); return r; }\n' }, {
  exit: 2,
  knownLimit: { reason: 'Como no g++ main.cpp util.c, o .c vira C++: malloc sem cast e extern "C" sem guarda dão erro de compilação, com mensagem normal.', actual: { compile: 'error', internal: false, diags: [{ file: 'util.c', line: 2, severity: 'error' }] } },
})
multi('cpp-em-projeto-c', 'c', { 'main.c': 'int main(void) { return 0; }\n', 'extra.cpp': 'isso nao e c++ valido\n' }, { exit: 0, note: 'projeto C ignora .cpp em silêncio.' })
multi('header-com-nome-de-sistema', 'c', { 'main.c': '#include <stdio.h>\n#include "stdio.h"\nint main(void) { printf("%d\\n", MEU); return 0; }\n', 'stdio.h': '#define MEU 8\n' }, { stdout: '8\n' })
multi('nome-com-ponto-e-traco', 'c', { 'main-1.v2.c': '#include "x-y.h"\nint main(void) { return V; }\n', 'x-y.h': '#define V 6\n' }, { exit: 6 })
multi('vinte-arquivos', 'c', Object.fromEntries([['main.c', Array.from({ length: 19 }, (_, i) => `int f${i}(void);`).join('\n') + '\nint main(void) { return ' + Array.from({ length: 19 }, (_, i) => `f${i}()`).join('+') + '; }\n'], ...Array.from({ length: 19 }, (_, i) => [`f${i}.c`, `int f${i}(void) { return 1; }\n`])]), { exit: 19, harnessMs: 90_000, note: 'MAX_FILES: um processo clang por arquivo.' })

// -------------------------------------------------------------------------- sandbox
group = 'sandbox'
c('fopen-leitura', R`#include <stdio.h>
int main(void) { FILE *f = fopen("/etc/passwd", "r"); FILE *g = fopen("main.c", "r"); printf("%d %d\n", f == NULL, g == NULL); return 0; }`, { stdout: '1 1\n' })
c('fopen-escrita', R`#include <stdio.h>
int main(void) { FILE *f = fopen("saida.txt", "w"); printf("%d\n", f == NULL); if (f) { fputs("x", f); fclose(f); } return 0; }`, { stdout: '1\n' })
c('opendir', R`#include <dirent.h>
#include <stdio.h>
int main(void) { DIR *d = opendir("/"); printf("%d\n", d == NULL); return 0; }`, { stdout: '1\n' })
c('system', R`#include <stdlib.h>
int main(void) { return system("ls"); }`, { compile: 'error', internal: false })
c('socket', R`#include <sys/socket.h>
#include <stdio.h>
int main(void) { int s = socket(AF_INET, SOCK_STREAM, 0); printf("%d\n", s); return 0; }`, { anyCompile: true, anyExit: true, check: (o) => (o.compile.ok ? (o.run?.stdout === '-1\n' ? null : `socket devolveu ${o.run?.stdout}`) : null), note: 'ou não compila, ou devolve -1.' })
c('fork', R`#include <unistd.h>
int main(void) { return fork(); }`, { compile: 'error', internal: false })
c('exec', R`#include <unistd.h>
int main(void) { return execl("/bin/sh", "sh", (char *)0); }`, { compile: 'error', internal: false })
c('dlopen', R`#include <dlfcn.h>
int main(void) { return dlopen("x", 0) != 0; }`, { compile: 'error', internal: false, note: 'sem carga dinâmica.' })
c('getenv', R`#include <stdio.h>
#include <stdlib.h>
int main(void) { printf("%d %d\n", getenv("PATH") == NULL, getenv("HOME") == NULL); return 0; }`, { stdout: '1 1\n' })
c('time-rand', R`#include <stdio.h>
#include <stdlib.h>
#include <time.h>
int main(void) { srand(time(NULL)); int a = rand(), b = rand(); printf("%d\n", a != b); return 0; }`, { stdout: '1\n' })
c('sleep-curto', R`#include <stdio.h>
#include <unistd.h>
int main(void) { usleep(10000); sleep(0); puts("ok"); return 0; }`, { stdout: 'ok\n' })
c('sleep-longo', R`#include <stdio.h>
#include <unistd.h>
int main(void) { puts("a"); sleep(100); puts("b"); return 0; }`, { timedOut: true, stdout: 'a\n', timeoutMs: 1500 })
c('getpid', R`#include <stdio.h>
#include <unistd.h>
int main(void) { printf("%d\n", getpid() > 0); return 0; }`, { stdout: '1\n' })
c('mmap', R`#include <stdio.h>
#include <sys/mman.h>
int main(void) { void *p = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0); printf("%d\n", p != MAP_FAILED); return 0; }`, { anyCompile: true, anyExit: true, check: (o) => (o.compile.ok === true || !o.compile.internal ? null : 'erro interno'), note: 'mmap exige emulação: é erro de compilação claro.' })
c('import-host-inexistente', R`__attribute__((import_module("env"), import_name("alert"))) void alert(int);
int main(void) { alert(1); return 0; }`, { error: IMPORT, exit: 139, note: 'o wasm é válido, a falha só aparece ao instanciar.' })
c('import-wasi-inexistente', R`__attribute__((import_module("wasi_snapshot_preview1"), import_name("sock_accept2"))) int s(int);
int main(void) { return s(1); }`, { error: IMPORT, exit: 139 })
c('import-global-this', R`__attribute__((import_module("window"), import_name("eval"))) int ev(int);
int main(void) { return ev(0); }`, { error: IMPORT, exit: 139, note: 'só wasi_snapshot_preview1 é fornecido: sem acesso ao JS da página.' })
c('wasi-direto-ponteiro-ruim', R`#include <wasi/api.h>
#include <stdio.h>
int main(void) { __wasi_ciovec_t v = { (const uint8_t *)0xFFFFFFF0u, 1000 }; __wasi_size_t n = 0; int r = __wasi_fd_write(1, &v, 1, &n); printf("%d\n", r != 0 || n == 1000); return 0; }`, {
  anyExit: true, check: ran, note: 'ponteiro ruim numa chamada WASI direta: precisa terminar contido, qualquer que seja o erro.',
})
c('wasi-random-gigante', R`#include <stdio.h>
#include <stdlib.h>
#include <wasi/api.h>
int main(void) { char *b = malloc(1 << 24); int r = __wasi_random_get((uint8_t *)b, 1 << 24); printf("%d\n", r); return 0; }`, { stdout: '0\n', note: 'getRandomValues aceita só 64 KiB de cada vez.' })
c('fd-invalido', R`#include <stdio.h>
#include <unistd.h>
int main(void) { char b[4]; printf("%d %d\n", (int)write(55, "x", 1), (int)read(55, b, 1)); return 0; }`, { stdout: '-1 -1\n' })
c('fecha-stdout', R`#include <stdio.h>
#include <unistd.h>
int main(void) { puts("a"); fflush(stdout); close(1); puts("b"); fflush(stdout); close(0); fputs("c", stderr); return 0; }`, { anyExit: true, check: (o) => (o.run?.stdout.startsWith('a\n') ? null : `stdout ${o.run?.stdout}`), note: 'fechar stdout não pode travar nem quebrar o worker.' })
c('asm-unreachable', R`int main(void) { __asm__("unreachable"); return 0; }`, { error: ABORT, exit: 139 })
c('start-proprio', R`void _start(void) { }`, { anyCompile: true, anyExit: true, check: (o) => (o.compile.ok ? ran(o) : null), note: 'aluno define _start: duplicado no link, ou roda e sai.' })

// ---------------------------------------------------------------------- concorrência
group = 'robust'
const BURN = R`#include <stdio.h>
int main(void) { long n; scanf("%ld", &n); volatile long s = 0; for (long i = 0; i < n * 2000000L; i++) s += i; printf("%ld\n", n); return 0; }`
const LOOP = R`#include <stdio.h>
int main(void) { puts("rodando"); fflush(stdout); volatile int x = 1; while (x) { } return 0; }`
scenario('8-runs-concorrentes', async ({ mustCompile, run }) => {
  const wasm = await mustCompile('c', BURN)
  const failures: string[] = []
  const t0 = performance.now()
  const res = await Promise.all(Array.from({ length: 8 }, (_, i) => run(wasm, String(i + 1), 60_000)))
  const ms = Math.round(performance.now() - t0)
  res.forEach((r, i) => { if (r.stdout !== `${i + 1}\n` || r.exitCode !== 0 || r.error) failures.push(`run ${i}: ${JSON.stringify(r)}`) })
  return { failures, metrics: { totalMs: ms } }
}, { harnessMs: 120_000 })
scenario('32-runs-mistos', async ({ mustCompile, run }) => {
  const ok = await mustCompile('c', '#include <stdio.h>\nint main(void) { int x; scanf("%d", &x); printf("%d", x); return 0; }')
  const loop = await mustCompile('c', LOOP)
  const trap = await mustCompile('c', 'int main(void) { volatile int a = 7, z = 0; return a / z; }')
  const failures: string[] = []
  const res = await Promise.all(Array.from({ length: 32 }, (_, i) => {
    if (i % 3 === 0) return run(ok, String(i), 30_000).then((r) => (r.stdout === String(i) ? null : `ok ${i}: ${JSON.stringify(r)}`))
    if (i % 3 === 1) return run(loop, '', 1500).then((r) => (r.timedOut ? null : `loop ${i}: ${JSON.stringify(r)}`))
    return run(trap, '', 30_000).then((r) => (/Divis/.test(r.error ?? '') ? null : `trap ${i}: ${JSON.stringify(r)}`))
  }))
  for (const r of res) if (r) failures.push(r)
  return { failures }
}, { harnessMs: 120_000 })
scenario('kill-no-meio', async ({ mustCompile, run }) => {
  const wasm = await mustCompile('c', LOOP)
  const failures: string[] = []
  const job = run(wasm, '', 60_000)
  await new Promise((r) => setTimeout(r, 800))
  const t0 = performance.now()
  job.kill()
  const r = await job
  const ms = performance.now() - t0
  if (r.timedOut) failures.push('kill marcou timedOut')
  if (!/Interrompido/.test(r.error ?? '')) failures.push(`erro: ${r.error}`)
  if (ms > 200) failures.push(`kill levou ${Math.round(ms)} ms`)
  if (r.stdout !== 'rodando\n') failures.push(`stdout até o kill: ${JSON.stringify(r.stdout)}`)
  job.kill()
  return { failures, metrics: { killMs: Math.round(ms) } }
}, { harnessMs: 30_000 })
scenario('kill-imediato-e-repetido', async ({ mustCompile, run }) => {
  const wasm = await mustCompile('c', LOOP)
  const failures: string[] = []
  for (let i = 0; i < 20; i++) {
    const job = run(wasm, '', 60_000)
    job.kill()
    job.kill()
    const r = await job
    if (!/Interrompido/.test(r.error ?? '')) failures.push(`kill ${i}: ${r.error}`)
  }
  return { failures }
}, { harnessMs: 30_000 })
scenario('kill-depois-do-fim', async ({ mustCompile, run }) => {
  const wasm = await mustCompile('c', 'int main(void) { return 4; }')
  const job = run(wasm, '', 5000)
  const r = await job
  job.kill()
  return { failures: r.exitCode === 4 ? [] : [`código ${r.exitCode}`] }
}, { harnessMs: 30_000 })
scenario('wasm-invalido', async ({ run }) => {
  const failures: string[] = []
  const lixo = await run(new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>, '', 5000)
  if (!lixo.error) failures.push('wasm lixo sem erro')
  const vazio = await run(new Uint8Array(0) as Uint8Array<ArrayBuffer>, '', 5000)
  if (!vazio.error) failures.push('wasm vazio sem erro')
  return { failures, notes: [lixo.error ?? ''] }
}, { harnessMs: 30_000 })
scenario('compile-em-fila', async ({ compile, run }) => {
  const failures: string[] = []
  const order: number[] = []
  const jobs = Array.from({ length: 6 }, (_, i) => compile('c', { 'main.c': `#include <stdio.h>\nint main(void) { printf("%d", ${i}); return 0; }\n` }).then(async (r) => {
    order.push(i)
    if (!r.ok) return `compile ${i}: ${r.log}`
    const o = await run(r.wasm, '', 5000)
    return o.stdout === String(i) ? null : `run ${i}: ${o.stdout}`
  }))
  jobs.push(compile('c', { 'main.c': 'int main(void) { erro }' }).then((r) => { order.push(6); return r.ok ? 'erro de sintaxe compilou' : null }))
  jobs.push(compile('c', { 'main.c': 'int main(void) { return 0; }' }).then((r) => { order.push(7); return r.ok ? null : `após erro: ${r.log}` }))
  for (const r of await Promise.all(jobs)) if (r) failures.push(r)
  if (order.join() !== '0,1,2,3,4,5,6,7') failures.push(`ordem ${order}`)
  return { failures }
}, { harnessMs: 120_000 })
scenario('compile-e-run-simultaneos', async ({ compile, mustCompile, run }) => {
  const loop = await mustCompile('c', LOOP)
  const burners = [run(loop, '', 60_000), run(loop, '', 60_000), run(loop, '', 60_000)]
  const t0 = performance.now()
  const r = await compile('cpp', { 'main.cpp': '#include <vector>\n#include <iostream>\nint main() { std::vector<int> v{1}; std::cout << v[0]; }\n' })
  const ms = Math.round(performance.now() - t0)
  burners.forEach((b) => b.kill())
  await Promise.all(burners)
  return { failures: r.ok ? [] : [r.log], metrics: { compileComCargaMs: ms } }
}, { harnessMs: 120_000 })
scenario('progresso-compile', async ({ compile }) => {
  const seen: number[] = []
  const r = await compile('c', { 'main.c': 'int main(void) { return 0; }' }, (p) => seen.push(p))
  const failures = r.ok ? [] : ['falhou']
  if (seen.some((p) => !(p >= 0 && p <= 1))) failures.push('progresso fora de 0..1')
  return { failures, notes: [`${seen.length} eventos de progresso (0 é esperado depois da primeira compilação)`] }
}, { harnessMs: 60_000 })

export { cases }
export const SANITY_SRC = '#include <stdio.h>\nint main(void) { int x; scanf("%d", &x); printf("sanity %d\\n", x + 1); return 0; }\n'
