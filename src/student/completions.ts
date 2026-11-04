// Autocompletar offline para C e C++. Ainda não há clangd aqui: tudo sai destas tabelas e de
// uma leitura do próprio código por regex, então é um palpite bom, não uma análise de verdade.
import { monaco } from './monaco'
import { includePaths } from './fileTree'

type Model = monaco.editor.ITextModel
type Position = monaco.Position
type Item = monaco.languages.CompletionItem
type Range = monaco.IRange

// ---- tabelas

// [assinatura, descrição, snippet opcional]. No snippet, § vira `std::` quando não há `using namespace std`.
type Row = [sig: string, doc: string, snippet?: string]

const C_HEADERS: Record<string, Row[]> = {
  'stdio.h': [
    ['int printf(const char *formato, ...)', 'Escreve texto formatado na saída padrão.', 'printf("${1:%d}\\n"${2:, valor})$0'],
    ['int scanf(const char *formato, ...)', 'Lê valores formatados da entrada padrão.', 'scanf("${1:%d}", &${2:valor})$0'],
    ['int fprintf(FILE *arquivo, const char *formato, ...)', 'Escreve texto formatado em um arquivo.'],
    ['int fscanf(FILE *arquivo, const char *formato, ...)', 'Lê valores formatados de um arquivo.'],
    ['int sprintf(char *destino, const char *formato, ...)', 'Escreve texto formatado em uma string, sem checar o tamanho.'],
    ['int snprintf(char *destino, size_t tamanho, const char *formato, ...)', 'Escreve texto formatado em uma string, respeitando o tamanho.'],
    ['int sscanf(const char *origem, const char *formato, ...)', 'Lê valores formatados de uma string.'],
    ['int puts(const char *texto)', 'Escreve o texto e uma quebra de linha.'],
    ['char *fgets(char *destino, int tamanho, FILE *arquivo)', 'Lê uma linha, incluindo o \\n, até o limite de tamanho.', 'fgets(${1:texto}, ${2:sizeof($1)}, ${3:stdin})$0'],
    ['int fputs(const char *texto, FILE *arquivo)', 'Escreve o texto em um arquivo, sem quebra de linha.'],
    ['int putchar(int c)', 'Escreve um caractere na saída padrão.'],
    ['int getchar(void)', 'Lê um caractere da entrada padrão.', 'getchar()$0'],
    ['FILE *fopen(const char *caminho, const char *modo)', 'Abre um arquivo e devolve NULL se falhar.', 'fopen("${1:arquivo.txt}", "${2:r}")$0'],
    ['int fclose(FILE *arquivo)', 'Fecha um arquivo aberto.'],
    ['size_t fread(void *destino, size_t tamanho, size_t quantidade, FILE *arquivo)', 'Lê blocos binários de um arquivo.'],
    ['size_t fwrite(const void *origem, size_t tamanho, size_t quantidade, FILE *arquivo)', 'Escreve blocos binários em um arquivo.'],
    ['int fflush(FILE *arquivo)', 'Envia na hora o que está no buffer de saída.'],
    ['int feof(FILE *arquivo)', 'Diz se a leitura chegou ao fim do arquivo.'],
    ['int fgetc(FILE *arquivo)', 'Lê um caractere de um arquivo.'],
    ['int fputc(int c, FILE *arquivo)', 'Escreve um caractere em um arquivo.'],
    ['int fseek(FILE *arquivo, long deslocamento, int origem)', 'Move a posição de leitura ou escrita.'],
    ['long ftell(FILE *arquivo)', 'Devolve a posição atual no arquivo.'],
    ['void rewind(FILE *arquivo)', 'Volta para o início do arquivo.'],
    ['void perror(const char *prefixo)', 'Escreve em stderr a mensagem do último erro.'],
    ['FILE', 'Tipo que representa um arquivo aberto.'],
    ['EOF', 'Valor devolvido quando a leitura chega ao fim.'],
    ['NULL', 'Ponteiro nulo.'],
    ['FILE *stdin', 'Entrada padrão.'],
    ['FILE *stdout', 'Saída padrão.'],
    ['FILE *stderr', 'Saída de erros.'],
    ['SEEK_SET', 'fseek a partir do início do arquivo.'],
    ['SEEK_CUR', 'fseek a partir da posição atual.'],
    ['SEEK_END', 'fseek a partir do fim do arquivo.'],
  ],
  'stdlib.h': [
    ['void *malloc(size_t bytes)', 'Reserva memória sem inicializar; devolve NULL se faltar.', 'malloc(${1:n} * sizeof(${2:int}))$0'],
    ['void *calloc(size_t quantidade, size_t tamanho)', 'Reserva memória zerada.', 'calloc(${1:n}, sizeof(${2:int}))$0'],
    ['void *realloc(void *ponteiro, size_t bytes)', 'Muda o tamanho de um bloco, podendo movê-lo.'],
    ['void free(void *ponteiro)', 'Libera memória reservada com malloc, calloc ou realloc.'],
    ['int atoi(const char *texto)', 'Converte texto em int.'],
    ['long atol(const char *texto)', 'Converte texto em long.'],
    ['double atof(const char *texto)', 'Converte texto em double.'],
    ['long strtol(const char *texto, char **fim, int base)', 'Converte texto em long, na base indicada.', 'strtol(${1:texto}, ${2:NULL}, ${3:10})$0'],
    ['double strtod(const char *texto, char **fim)', 'Converte texto em double e indica onde parou.'],
    ['int abs(int x)', 'Valor absoluto de um int.'],
    ['long labs(long x)', 'Valor absoluto de um long.'],
    ['int rand(void)', 'Número pseudoaleatório entre 0 e RAND_MAX.', 'rand()$0'],
    ['void srand(unsigned int semente)', 'Define a semente de rand.'],
    ['void qsort(void *base, size_t quantidade, size_t tamanho, int (*comparar)(const void *, const void *))', 'Ordena um vetor usando a função de comparação.', 'qsort(${1:vetor}, ${2:n}, sizeof(${3:int}), ${4:comparar})$0'],
    ['void *bsearch(const void *chave, const void *base, size_t quantidade, size_t tamanho, int (*comparar)(const void *, const void *))', 'Busca binária em um vetor ordenado.'],
    ['void exit(int codigo)', 'Encerra o programa com o código informado.'],
    ['void abort(void)', 'Encerra o programa na hora, de forma anormal.', 'abort()$0'],
    ['EXIT_SUCCESS', 'Código de saída de sucesso.'],
    ['EXIT_FAILURE', 'Código de saída de falha.'],
    ['RAND_MAX', 'Maior valor que rand pode devolver.'],
    ['size_t', 'Tipo sem sinal usado para tamanhos.'],
  ],
  'string.h': [
    ['size_t strlen(const char *texto)', 'Tamanho do texto, sem contar o \\0.'],
    ['char *strcpy(char *destino, const char *origem)', 'Copia o texto, inclusive o \\0, sem checar o tamanho.'],
    ['char *strncpy(char *destino, const char *origem, size_t n)', 'Copia até n caracteres; pode não terminar em \\0.'],
    ['char *strcat(char *destino, const char *origem)', 'Junta a origem ao fim do destino.'],
    ['char *strncat(char *destino, const char *origem, size_t n)', 'Junta até n caracteres ao fim do destino.'],
    ['int strcmp(const char *a, const char *b)', 'Compara dois textos: 0 quando são iguais.'],
    ['int strncmp(const char *a, const char *b, size_t n)', 'Compara até n caracteres.'],
    ['char *strchr(const char *texto, int c)', 'Primeira ocorrência do caractere, ou NULL.'],
    ['char *strrchr(const char *texto, int c)', 'Última ocorrência do caractere, ou NULL.'],
    ['char *strstr(const char *texto, const char *trecho)', 'Primeira ocorrência do trecho, ou NULL.'],
    ['char *strtok(char *texto, const char *separadores)', 'Quebra o texto em pedaços, alterando o original.'],
    ['void *memset(void *destino, int valor, size_t bytes)', 'Preenche os bytes com o valor.', 'memset(${1:vetor}, ${2:0}, sizeof($1))$0'],
    ['void *memcpy(void *destino, const void *origem, size_t bytes)', 'Copia bytes; as áreas não podem se sobrepor.'],
    ['void *memmove(void *destino, const void *origem, size_t bytes)', 'Copia bytes, mesmo com áreas sobrepostas.'],
    ['int memcmp(const void *a, const void *b, size_t bytes)', 'Compara bytes: 0 quando são iguais.'],
  ],
  'math.h': [
    ['double pow(double base, double expoente)', 'Base elevada ao expoente.'],
    ['double sqrt(double x)', 'Raiz quadrada.'],
    ['double cbrt(double x)', 'Raiz cúbica.'],
    ['double fabs(double x)', 'Valor absoluto de um double.'],
    ['double floor(double x)', 'Arredonda para baixo.'],
    ['double ceil(double x)', 'Arredonda para cima.'],
    ['double round(double x)', 'Arredonda para o inteiro mais próximo.'],
    ['double trunc(double x)', 'Descarta a parte fracionária.'],
    ['double fmod(double x, double y)', 'Resto da divisão de números reais.'],
    ['double exp(double x)', 'e elevado a x.'],
    ['double log(double x)', 'Logaritmo natural.'],
    ['double log10(double x)', 'Logaritmo na base 10.'],
    ['double log2(double x)', 'Logaritmo na base 2.'],
    ['double sin(double x)', 'Seno, com x em radianos.'],
    ['double cos(double x)', 'Cosseno, com x em radianos.'],
    ['double tan(double x)', 'Tangente, com x em radianos.'],
    ['double asin(double x)', 'Arco seno, em radianos.'],
    ['double acos(double x)', 'Arco cosseno, em radianos.'],
    ['double atan(double x)', 'Arco tangente, em radianos.'],
    ['double atan2(double y, double x)', 'Arco tangente de y/x, levando em conta o quadrante.'],
    ['double hypot(double x, double y)', 'Hipotenusa: raiz de x² + y².'],
    ['int isnan(double x)', 'Diz se o valor é NaN.'],
    ['int isinf(double x)', 'Diz se o valor é infinito.'],
    ['M_PI', 'O número pi.'],
    ['M_E', 'O número de Euler.'],
    ['INFINITY', 'Infinito positivo.'],
    ['NAN', 'Valor que não é um número.'],
  ],
  'ctype.h': [
    ['int isalpha(int c)', 'Diz se é uma letra.'],
    ['int isdigit(int c)', 'Diz se é um dígito de 0 a 9.'],
    ['int isalnum(int c)', 'Diz se é letra ou dígito.'],
    ['int isspace(int c)', 'Diz se é espaço, tabulação ou quebra de linha.'],
    ['int isupper(int c)', 'Diz se é letra maiúscula.'],
    ['int islower(int c)', 'Diz se é letra minúscula.'],
    ['int ispunct(int c)', 'Diz se é pontuação.'],
    ['int isxdigit(int c)', 'Diz se é dígito hexadecimal.'],
    ['int toupper(int c)', 'Converte para maiúscula.'],
    ['int tolower(int c)', 'Converte para minúscula.'],
  ],
  'stdbool.h': [
    ['bool', 'Tipo lógico.'],
    ['bool true', 'Verdadeiro.'],
    ['bool false', 'Falso.'],
  ],
  'limits.h': [
    ['INT_MAX', 'Maior valor de int.'],
    ['INT_MIN', 'Menor valor de int.'],
    ['UINT_MAX', 'Maior valor de unsigned int.'],
    ['LONG_MAX', 'Maior valor de long.'],
    ['LONG_MIN', 'Menor valor de long.'],
    ['LLONG_MAX', 'Maior valor de long long.'],
    ['LLONG_MIN', 'Menor valor de long long.'],
    ['ULLONG_MAX', 'Maior valor de unsigned long long.'],
    ['CHAR_MAX', 'Maior valor de char.'],
    ['CHAR_MIN', 'Menor valor de char.'],
    ['SHRT_MAX', 'Maior valor de short.'],
    ['SHRT_MIN', 'Menor valor de short.'],
  ],
  'time.h': [
    ['time_t time(time_t *destino)', 'Hora atual em segundos desde 1970.', 'time(${1:NULL})$0'],
    ['clock_t clock(void)', 'Tempo de processador usado até agora.', 'clock()$0'],
    ['double difftime(time_t fim, time_t inicio)', 'Diferença entre dois horários, em segundos.'],
    ['struct tm *localtime(const time_t *horario)', 'Separa o horário em ano, mês, dia e hora locais.'],
    ['size_t strftime(char *destino, size_t tamanho, const char *formato, const struct tm *horario)', 'Escreve uma data formatada em uma string.'],
    ['time_t', 'Tipo que guarda um horário.'],
    ['clock_t', 'Tipo que guarda tempo de processador.'],
    ['CLOCKS_PER_SEC', 'Quantos tiques de clock há em um segundo.'],
  ],
  'stdint.h': [
    ['int8_t', 'Inteiro de 8 bits com sinal.'],
    ['int16_t', 'Inteiro de 16 bits com sinal.'],
    ['int32_t', 'Inteiro de 32 bits com sinal.'],
    ['int64_t', 'Inteiro de 64 bits com sinal.'],
    ['uint8_t', 'Inteiro de 8 bits sem sinal.'],
    ['uint16_t', 'Inteiro de 16 bits sem sinal.'],
    ['uint32_t', 'Inteiro de 32 bits sem sinal.'],
    ['uint64_t', 'Inteiro de 64 bits sem sinal.'],
  ],
  'assert.h': [['void assert(int condicao)', 'Aborta o programa se a condição for falsa.']],
}

const STD_HEADERS: Record<string, Row[]> = {
  iostream: [
    ['std::ostream cout', 'Saída padrão.', '§cout << ${1:valor}$0'],
    ['std::istream cin', 'Entrada padrão.', '§cin >> ${1:valor}$0'],
    ['std::ostream cerr', 'Saída de erros.', '§cerr << ${1:valor}$0'],
    ['std::ostream &endl', 'Quebra a linha e esvazia o buffer da saída.'],
    ['std::istream &ws', 'Pula espaços em branco na leitura.'],
  ],
  string: [
    ['std::string', 'Texto de tamanho variável.'],
    ['std::istream &getline(std::istream &entrada, std::string &texto)', 'Lê uma linha inteira, sem o \\n.', '§getline(§cin, ${1:texto})$0'],
    ['std::istream &getline(std::istream &entrada, std::string &texto, char separador)', 'Lê até encontrar o separador.'],
    ['std::string to_string(double valor)', 'Converte um número em texto.'],
    ['int stoi(const std::string &texto)', 'Converte texto em int.'],
    ['long stol(const std::string &texto)', 'Converte texto em long.'],
    ['long long stoll(const std::string &texto)', 'Converte texto em long long.'],
    ['float stof(const std::string &texto)', 'Converte texto em float.'],
    ['double stod(const std::string &texto)', 'Converte texto em double.'],
  ],
  vector: [['std::vector<T>', 'Vetor de tamanho variável.', '§vector<${1:int}>$0']],
  map: [['std::map<K, V>', 'Dicionário ordenado pela chave.', '§map<${1:string}, ${2:int}>$0']],
  set: [['std::set<T>', 'Conjunto ordenado, sem repetição.', '§set<${1:int}>$0']],
  unordered_map: [['std::unordered_map<K, V>', 'Dicionário por hash, sem ordem.', '§unordered_map<${1:string}, ${2:int}>$0']],
  unordered_set: [['std::unordered_set<T>', 'Conjunto por hash, sem ordem e sem repetição.', '§unordered_set<${1:int}>$0']],
  queue: [
    ['std::queue<T>', 'Fila: sai primeiro quem entrou primeiro.', '§queue<${1:int}>$0'],
    ['std::priority_queue<T>', 'Fila em que o maior elemento sai primeiro.', '§priority_queue<${1:int}>$0'],
  ],
  stack: [['std::stack<T>', 'Pilha: sai primeiro quem entrou por último.', '§stack<${1:int}>$0']],
  deque: [['std::deque<T>', 'Fila com inserção rápida nas duas pontas.', '§deque<${1:int}>$0']],
  list: [['std::list<T>', 'Lista duplamente ligada.', '§list<${1:int}>$0']],
  array: [['std::array<T, N>', 'Vetor de tamanho fixo.', '§array<${1:int}, ${2:10}>$0']],
  utility: [
    ['std::pair<T, U>', 'Dois valores juntos.', '§pair<${1:int}, ${2:int}>$0'],
    ['std::pair<T, U> make_pair(T a, U b)', 'Cria um pair sem precisar escrever os tipos.'],
    ['void swap(T &a, T &b)', 'Troca dois valores.'],
  ],
  algorithm: [
    ['void sort(It inicio, It fim)', 'Ordena o intervalo em ordem crescente.', '§sort(${1:v}.begin(), $1.end())$0'],
    ['void sort(It inicio, It fim, Comparar comparar)', 'Ordena usando a função de comparação.'],
    ['void stable_sort(It inicio, It fim)', 'Ordena mantendo a ordem relativa dos iguais.', '§stable_sort(${1:v}.begin(), $1.end())$0'],
    ['void reverse(It inicio, It fim)', 'Inverte o intervalo.', '§reverse(${1:v}.begin(), $1.end())$0'],
    ['const T &min(const T &a, const T &b)', 'Devolve o menor valor.'],
    ['const T &max(const T &a, const T &b)', 'Devolve o maior valor.'],
    ['It find(It inicio, It fim, const T &valor)', 'Iterador para o primeiro igual ao valor, ou fim.', '§find(${1:v}.begin(), $1.end(), ${2:valor})$0'],
    ['It find_if(It inicio, It fim, Predicado predicado)', 'Iterador para o primeiro que satisfaz o predicado.'],
    ['long count(It inicio, It fim, const T &valor)', 'Quantos elementos são iguais ao valor.', '§count(${1:v}.begin(), $1.end(), ${2:valor})$0'],
    ['long count_if(It inicio, It fim, Predicado predicado)', 'Quantos elementos satisfazem o predicado.'],
    ['bool binary_search(It inicio, It fim, const T &valor)', 'Diz se o valor existe em um intervalo ordenado.', '§binary_search(${1:v}.begin(), $1.end(), ${2:valor})$0'],
    ['It lower_bound(It inicio, It fim, const T &valor)', 'Primeiro elemento que não é menor que o valor.', '§lower_bound(${1:v}.begin(), $1.end(), ${2:valor})$0'],
    ['It upper_bound(It inicio, It fim, const T &valor)', 'Primeiro elemento maior que o valor.', '§upper_bound(${1:v}.begin(), $1.end(), ${2:valor})$0'],
    ['It unique(It inicio, It fim)', 'Move repetidos vizinhos para o fim e devolve o novo fim.', '§unique(${1:v}.begin(), $1.end())$0'],
    ['void fill(It inicio, It fim, const T &valor)', 'Preenche o intervalo com o valor.', '§fill(${1:v}.begin(), $1.end(), ${2:0})$0'],
    ['bool next_permutation(It inicio, It fim)', 'Avança para a próxima permutação.', '§next_permutation(${1:v}.begin(), $1.end())$0'],
    ['It min_element(It inicio, It fim)', 'Iterador para o menor elemento.', '§min_element(${1:v}.begin(), $1.end())$0'],
    ['It max_element(It inicio, It fim)', 'Iterador para o maior elemento.', '§max_element(${1:v}.begin(), $1.end())$0'],
    ['bool all_of(It inicio, It fim, Predicado predicado)', 'Diz se todos satisfazem o predicado.'],
    ['bool any_of(It inicio, It fim, Predicado predicado)', 'Diz se algum satisfaz o predicado.'],
    ['bool none_of(It inicio, It fim, Predicado predicado)', 'Diz se nenhum satisfaz o predicado.'],
  ],
  numeric: [
    ['T accumulate(It inicio, It fim, T inicial)', 'Soma o intervalo a partir do valor inicial.', '§accumulate(${1:v}.begin(), $1.end(), ${2:0})$0'],
    ['void iota(It inicio, It fim, T inicial)', 'Preenche com valores crescentes.', '§iota(${1:v}.begin(), $1.end(), ${2:0})$0'],
    ['T gcd(T a, T b)', 'Máximo divisor comum.'],
    ['T lcm(T a, T b)', 'Mínimo múltiplo comum.'],
  ],
  iomanip: [
    ['setw(int largura)', 'Largura do próximo valor impresso.'],
    ['setprecision(int casas)', 'Quantidade de dígitos ao imprimir números reais.'],
    ['setfill(char c)', 'Caractere usado para completar a largura.'],
    ['std::ios_base &fixed', 'Imprime reais com casas decimais fixas.'],
  ],
  sstream: [
    ['std::stringstream', 'Lê e escreve em um texto como se fosse cin e cout.'],
    ['std::istringstream', 'Lê de um texto como se fosse cin.'],
    ['std::ostringstream', 'Escreve em um texto como se fosse cout.'],
  ],
  fstream: [
    ['std::ifstream', 'Arquivo aberto para leitura.'],
    ['std::ofstream', 'Arquivo aberto para escrita.'],
  ],
  functional: [
    ['std::greater<T>', 'Comparação para ordenar do maior para o menor.', '§greater<${1:int}>()$0'],
    ['std::less<T>', 'Comparação para ordenar do menor para o maior.', '§less<${1:int}>()$0'],
  ],
  limits: [['std::numeric_limits<T>', 'Limites de um tipo numérico.', '§numeric_limits<${1:int}>::${2:max}()$0']],
}

const SIZE: Row = ['size_t size()', 'Quantidade de elementos.']
const EMPTY: Row = ['bool empty()', 'Diz se está vazio.']
const CLEAR: Row = ['void clear()', 'Remove todos os elementos.']
const BEGIN: Row = ['iterator<T> begin()', 'Iterador para o primeiro elemento.']
const END: Row = ['iterator<T> end()', 'Iterador para depois do último elemento.']
const FRONT: Row = ['T &front()', 'O primeiro elemento.']
const BACK: Row = ['T &back()', 'O último elemento.']
const AT: Row = ['T &at(size_t posicao)', 'Elemento na posição, com checagem de limite.']
const PUSH_BACK: Row = ['void push_back(const T &valor)', 'Coloca no fim.']
const POP_BACK: Row = ['void pop_back()', 'Remove o último.']
const PUSH_FRONT: Row = ['void push_front(const T &valor)', 'Coloca no início.']
const POP_FRONT: Row = ['void pop_front()', 'Remove o primeiro.']
const ERASE_AT: Row = ['iterator<T> erase(iterator<T> posicao)', 'Remove o elemento apontado.']
const INSERT_AT: Row = ['iterator<T> insert(iterator<T> posicao, const T &valor)', 'Insere antes da posição.']
const PUSH: Row = ['void push(const T &valor)', 'Coloca um elemento.']
const POP: Row = ['void pop()', 'Remove o próximo elemento, sem devolvê-lo.']
const TOP: Row = ['T &top()', 'O próximo elemento a sair.']

const SET_ROWS: Row[] = [
  ['void insert(const T &valor)', 'Insere; não faz nada se já existir.'],
  ['size_t erase(const T &valor)', 'Remove o valor e devolve quantos saíram.'],
  ['iterator<T> find(const T &valor)', 'Iterador para o valor, ou end() se não existir.'],
  ['size_t count(const T &valor)', 'Devolve 1 se o valor existir, 0 se não.'],
  ['bool contains(const T &valor)', 'Diz se o valor existe.'],
  SIZE,
  EMPTY,
  CLEAR,
  BEGIN,
  END,
]

const MAP_ROWS: Row[] = [
  ['void insert(const pair<K, V> &par)', 'Insere; não faz nada se a chave já existir.', 'insert({${1:chave}, ${2:valor}})$0'],
  ['size_t erase(const K &chave)', 'Remove a chave e devolve quantos saíram.'],
  ['iterator<pair<K, V>> find(const K &chave)', 'Iterador para a chave, ou end() se não existir.'],
  ['size_t count(const K &chave)', 'Devolve 1 se a chave existir, 0 se não.'],
  ['bool contains(const K &chave)', 'Diz se a chave existe.'],
  ['V &at(const K &chave)', 'Valor da chave; lança erro se não existir.'],
  SIZE,
  EMPTY,
  CLEAR,
  ['iterator<pair<K, V>> begin()', 'Iterador para o primeiro par.'],
  ['iterator<pair<K, V>> end()', 'Iterador para depois do último par.'],
]

const MEMBER_ROWS: Record<string, Row[]> = {
  string: [
    ['size_t size()', 'Quantidade de caracteres.'],
    ['size_t length()', 'Quantidade de caracteres.'],
    EMPTY,
    ['void clear()', 'Deixa o texto vazio.'],
    ['void push_back(char c)', 'Coloca um caractere no fim.'],
    ['void pop_back()', 'Remove o último caractere.'],
    ['string &append(const string &texto)', 'Junta o texto ao fim.'],
    ['string substr(size_t inicio, size_t tamanho)', 'Pedaço do texto. Sem o tamanho, vai até o fim.'],
    ['size_t find(const string &trecho)', 'Posição do trecho, ou string::npos.'],
    ['size_t rfind(const string &trecho)', 'Última posição do trecho, ou string::npos.'],
    ['string &replace(size_t inicio, size_t tamanho, const string &novo)', 'Troca um pedaço do texto.'],
    ['string &insert(size_t posicao, const string &texto)', 'Insere o texto na posição.'],
    ['string &erase(size_t inicio, size_t tamanho)', 'Remove um pedaço do texto.'],
    ['const char *c_str()', 'O texto como string de C.'],
    ['int compare(const string &outro)', 'Compara dois textos: 0 quando são iguais.'],
    ['char &at(size_t posicao)', 'Caractere na posição, com checagem de limite.'],
    ['char &front()', 'O primeiro caractere.'],
    ['char &back()', 'O último caractere.'],
    ['iterator<char> begin()', 'Iterador para o primeiro caractere.'],
    ['iterator<char> end()', 'Iterador para depois do último caractere.'],
  ],
  vector: [
    PUSH_BACK,
    ['void emplace_back(...)', 'Constrói um elemento direto no fim.'],
    POP_BACK,
    SIZE,
    EMPTY,
    CLEAR,
    AT,
    FRONT,
    BACK,
    BEGIN,
    END,
    ['iterator<T> rbegin()', 'Iterador reverso para o último elemento.'],
    ['iterator<T> rend()', 'Iterador reverso para antes do primeiro.'],
    INSERT_AT,
    ERASE_AT,
    ['void resize(size_t tamanho)', 'Muda a quantidade de elementos.'],
    ['void reserve(size_t capacidade)', 'Reserva espaço sem mudar o tamanho.'],
    ['void assign(size_t quantidade, const T &valor)', 'Substitui tudo por cópias do valor.'],
    ['size_t capacity()', 'Quantos elementos cabem antes de realocar.'],
    ['T *data()', 'Ponteiro para o primeiro elemento.'],
  ],
  deque: [PUSH_BACK, PUSH_FRONT, POP_BACK, POP_FRONT, SIZE, EMPTY, CLEAR, AT, FRONT, BACK, BEGIN, END, INSERT_AT, ERASE_AT],
  list: [
    PUSH_BACK,
    PUSH_FRONT,
    POP_BACK,
    POP_FRONT,
    SIZE,
    EMPTY,
    CLEAR,
    FRONT,
    BACK,
    BEGIN,
    END,
    INSERT_AT,
    ERASE_AT,
    ['void remove(const T &valor)', 'Remove todos os iguais ao valor.'],
    ['void sort()', 'Ordena a lista.'],
    ['void reverse()', 'Inverte a lista.'],
  ],
  array: [SIZE, EMPTY, AT, FRONT, BACK, BEGIN, END, ['void fill(const T &valor)', 'Preenche com o valor.'], ['T *data()', 'Ponteiro para o primeiro elemento.']],
  map: [
    ...MAP_ROWS,
    ['iterator<pair<K, V>> lower_bound(const K &chave)', 'Primeiro par com chave não menor.'],
    ['iterator<pair<K, V>> upper_bound(const K &chave)', 'Primeiro par com chave maior.'],
  ],
  unordered_map: MAP_ROWS,
  set: [
    ...SET_ROWS,
    ['iterator<T> lower_bound(const T &valor)', 'Primeiro elemento não menor que o valor.'],
    ['iterator<T> upper_bound(const T &valor)', 'Primeiro elemento maior que o valor.'],
  ],
  unordered_set: SET_ROWS,
  queue: [PUSH, POP, FRONT, BACK, SIZE, EMPTY],
  priority_queue: [PUSH, POP, TOP, SIZE, EMPTY],
  stack: [PUSH, POP, TOP, SIZE, EMPTY],
  pair: [
    ['T first', 'O primeiro valor.'],
    ['U second', 'O segundo valor.'],
  ],
  istream: [
    ['void ignore(long quantidade, char ate)', 'Descarta caracteres, por exemplo o \\n que sobrou.'],
    ['int get()', 'Lê um caractere.'],
    ['int peek()', 'Olha o próximo caractere sem consumir.'],
    ['bool eof()', 'Diz se a leitura chegou ao fim.'],
    ['bool fail()', 'Diz se a última leitura falhou.'],
    ['void clear()', 'Limpa o estado de erro.'],
  ],
  ostream: [
    ['ostream &flush()', 'Envia na hora o que está no buffer.'],
    ['long precision(long casas)', 'Define a quantidade de dígitos dos reais.'],
    ['long width(long largura)', 'Largura do próximo valor impresso.'],
  ],
}

const INCLUDES_C: [string, string][] = [
  ['stdio.h', 'Entrada e saída: printf, scanf, arquivos.'],
  ['stdlib.h', 'Memória, conversões, rand, qsort, exit.'],
  ['string.h', 'Funções de texto e de memória.'],
  ['math.h', 'Funções matemáticas.'],
  ['ctype.h', 'Classificação e conversão de caracteres.'],
  ['stdbool.h', 'Tipo bool, true e false.'],
  ['limits.h', 'Limites dos tipos inteiros.'],
  ['time.h', 'Data, hora e tempo de processador.'],
  ['stdint.h', 'Inteiros com tamanho exato.'],
  ['stddef.h', 'size_t, NULL e offsetof.'],
  ['float.h', 'Limites dos tipos reais.'],
  ['assert.h', 'Macro assert.'],
]

const INCLUDES_CPP: [string, string][] = [
  ['iostream', 'cin, cout e cerr.'],
  ['iomanip', 'Formatação: setw, setprecision, fixed.'],
  ['string', 'std::string e conversões.'],
  ['vector', 'Vetor de tamanho variável.'],
  ['map', 'Dicionário ordenado.'],
  ['set', 'Conjunto ordenado.'],
  ['unordered_map', 'Dicionário por hash.'],
  ['unordered_set', 'Conjunto por hash.'],
  ['queue', 'queue e priority_queue.'],
  ['stack', 'Pilha.'],
  ['deque', 'Fila de duas pontas.'],
  ['list', 'Lista ligada.'],
  ['array', 'Vetor de tamanho fixo.'],
  ['utility', 'pair, make_pair e swap.'],
  ['algorithm', 'sort, find, min, max e outros.'],
  ['numeric', 'accumulate, iota, gcd e lcm.'],
  ['functional', 'greater, less e function.'],
  ['limits', 'numeric_limits.'],
  ['sstream', 'stringstream.'],
  ['fstream', 'ifstream e ofstream.'],
  ['tuple', 'Vários valores juntos.'],
  ['cstdio', 'printf, scanf e arquivos.'],
  ['cstdlib', 'Memória, conversões, rand, exit.'],
  ['cstring', 'Funções de texto de C.'],
  ['cmath', 'Funções matemáticas.'],
  ['cctype', 'Classificação de caracteres.'],
  ['climits', 'Limites dos tipos inteiros.'],
  ['ctime', 'Data, hora e tempo de processador.'],
  ['cstdint', 'Inteiros com tamanho exato.'],
  ['cassert', 'Macro assert.'],
]

const KEYWORDS_C = 'auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while'.split(' ')
const KEYWORDS_CPP = [...KEYWORDS_C, ...'bool catch class constexpr delete explicit false friend namespace new nullptr operator private protected public template this throw true try typename using virtual'.split(' ')]
const KEYWORD_SET = new Set(KEYWORDS_CPP)

type Snippet = { label: string; doc: string; body: string; only?: Lang }
type Lang = 'c' | 'cpp'

const SNIPPETS: Snippet[] = [
  { label: 'main', doc: 'Função principal', only: 'c', body: 'int main(void) {\n\t$0\n\treturn 0;\n}' },
  { label: 'main', doc: 'Função principal', only: 'cpp', body: 'int main() {\n\t$0\n\treturn 0;\n}' },
  { label: 'for', doc: 'Laço com contador', body: 'for (int ${1:i} = 0; $1 < ${2:n}; $1++) {\n\t$0\n}' },
  { label: 'forr', doc: 'Laço de trás para frente', body: 'for (int ${1:i} = ${2:n} - 1; $1 >= 0; $1--) {\n\t$0\n}' },
  { label: 'foreach', doc: 'Percorre um contêiner', only: 'cpp', body: 'for (auto &${1:item} : ${2:v}) {\n\t$0\n}' },
  { label: 'while', doc: 'Laço com condição', body: 'while (${1:condicao}) {\n\t$0\n}' },
  { label: 'do', doc: 'Laço que roda ao menos uma vez', body: 'do {\n\t$0\n} while (${1:condicao});' },
  { label: 'if', doc: 'Condição', body: 'if (${1:condicao}) {\n\t$0\n}' },
  { label: 'ifelse', doc: 'Condição com else', body: 'if (${1:condicao}) {\n\t$2\n} else {\n\t$0\n}' },
  { label: 'switch', doc: 'Escolha entre casos', body: 'switch (${1:valor}) {\n\tcase ${2:1}:\n\t\t$0\n\t\tbreak;\n\tdefault:\n\t\tbreak;\n}' },
  { label: 'struct', doc: 'Estrutura com typedef', only: 'c', body: 'typedef struct {\n\t$0\n} ${1:Nome};' },
  { label: 'struct', doc: 'Estrutura', only: 'cpp', body: 'struct ${1:Nome} {\n\t$0\n};' },
  { label: 'class', doc: 'Classe', only: 'cpp', body: 'class ${1:Nome} {\npublic:\n\t$1() {\n\t\t$0\n\t}\n\nprivate:\n};' },
]

const DIRECTIVES: Snippet[] = [
  { label: 'include <>', doc: 'Inclui um cabeçalho do sistema', body: 'include <$0>' },
  { label: 'include ""', doc: 'Inclui um arquivo da questão', body: 'include "$0"' },
  { label: 'define', doc: 'Define uma macro', body: 'define ${1:NOME} ${2:valor}$0' },
  { label: 'ifndef', doc: 'Proteção contra inclusão dupla', body: 'ifndef ${1:NOME_H}\n#define $1\n\n$0\n\n#endif' },
  { label: 'pragma once', doc: 'Inclui este arquivo uma vez só', body: 'pragma once$0' },
]

// ---- símbolos

type SymKind = 'fn' | 'var' | 'const' | 'type'

interface Sym {
  name: string
  kind: SymKind
  sig: string
  doc: string
  params: string[]
  snippet?: string
  header?: string
  std?: boolean
}

function splitTop(text: string) {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of text) {
    if ('(<[{'.includes(ch)) depth++
    if (')>]}'.includes(ch)) depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

function toSym([sig, doc, snippet]: Row, header?: string, std?: boolean): Sym {
  const open = sig.indexOf('(')
  if (open >= 0) {
    const name = sig.slice(0, open).match(/(\w+)\s*$/)?.[1] ?? sig
    const inner = sig.slice(open + 1, sig.lastIndexOf(')')).trim()
    const params = !inner || inner === 'void' ? [] : splitTop(inner)
    return { name, kind: 'fn', sig, doc, params, snippet, header, std }
  }
  const name = sig.replace(/<.*>/, '').match(/(\w+)\s*$/)?.[1] ?? sig
  const plain = sig.replace(/<.*>/, '')
  const kind: SymKind = /[\s&]/.test(plain) ? 'var' : /^[A-Z][A-Z0-9_]*$/.test(name) ? 'const' : 'type'
  return { name, kind, sig, doc, params: [], snippet, header, std }
}

const C_SYMS = Object.entries(C_HEADERS).flatMap(([header, rows]) => rows.map((r) => toSym(r, header)))
const STD_SYMS = Object.entries(STD_HEADERS).flatMap(([header, rows]) => rows.map((r) => toSym(r, header, true)))
const MEMBERS: Record<string, Sym[]> = Object.fromEntries(Object.entries(MEMBER_ROWS).map(([base, rows]) => [base, rows.map((r) => toSym(r))]))
const ELEMENT_INDEXED = new Set(['vector', 'deque', 'array', 'list', 'set', 'unordered_set', 'queue', 'stack', 'priority_queue'])
const MAP_LIKE = new Set(['map', 'unordered_map'])

const cppHeader = (header: string) => (header.endsWith('.h') ? `c${header.slice(0, -2)}` : header)

function paramName(param: string) {
  return param.match(/\(\*(\w+)\)/)?.[1] ?? param.replace(/\[\s*\]$/, '').match(/(\w+)$/)?.[1] ?? 'valor'
}

function defaultSnippet(sym: Sym) {
  if (sym.kind !== 'fn') return sym.name
  const args = sym.params.filter((p) => p !== '...').map((p, i) => `\${${i + 1}:${paramName(p)}}`)
  return `${sym.name}(${args.join(', ')})$0`
}

// ---- leitura do código

// Comentários e strings viram espaços do mesmo tamanho: os índices continuam valendo para o texto real.
const NOISE = /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/g
const blank = (m: string) => m.replace(/[^\n]/g, ' ')

interface Member extends Sym {
  valueType?: string
}

interface Analysis {
  version: number
  code: string
  mask: string
  includes: Set<string>
  structs: Map<string, Member[]>
  fns: Sym[]
  words: Map<string, number>
  usingStd: boolean
}

const cache = new WeakMap<Model, Analysis>()

function analyze(model: Model): Analysis {
  const version = model.getVersionId()
  const hit = cache.get(model)
  if (hit?.version === version) return hit
  const code = model.getValue()
  const mask = code.replace(NOISE, blank)
  const words = new Map<string, number>()
  for (const [w] of mask.matchAll(/\b[A-Za-z_]\w{2,}\b/g)) words.set(w, (words.get(w) ?? 0) + 1)
  const result: Analysis = {
    version,
    code,
    mask,
    includes: new Set(Array.from(code.matchAll(/^[ \t]*#[ \t]*include[ \t]*[<"]([^>"\n]+)[>"]/gm), (m) => m[1])),
    structs: scanStructs(mask),
    fns: scanFunctions(mask),
    words,
    usingStd: /\busing\s+namespace\s+std\s*;/.test(mask),
  }
  cache.set(model, result)
  return result
}

function closing(text: string, start: number) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return i
  }
  return text.length
}

function scanStructs(mask: string) {
  const out = new Map<string, Member[]>()
  for (const m of mask.matchAll(/\b(?:struct|class)\s+(\w+)?\s*(?::[^{;]*)?\{/g)) {
    const open = m.index + m[0].length - 1
    const end = closing(mask, open)
    const members = parseMembers(mask.slice(open + 1, end))
    const alias = mask.slice(end + 1, end + 80).match(/^\s*(\w+)\s*;/)?.[1]
    const typedefd = /\btypedef\s*$/.test(mask.slice(Math.max(0, m.index - 12), m.index))
    if (m[1]) out.set(m[1], members)
    if (alias && typedefd) out.set(alias, members)
  }
  return out
}

function parseMembers(body: string): Member[] {
  const members: Member[] = []
  // Tira o corpo dos métodos: só a declaração interessa, e os ';' de dentro atrapalhariam.
  let flat = ''
  let depth = 0
  for (const ch of body) {
    if (ch === '{') {
      if (depth++ === 0) flat += ';'
    } else if (ch === '}') depth--
    else if (depth === 0) flat += ch
  }
  for (const raw of flat.split(';')) {
    const stmt = raw.replace(/\b(?:public|private|protected)\s*:/g, '').trim()
    if (!stmt) continue
    if (stmt.includes('(')) {
      // Construtor e destrutor não entram: nunca são chamados com ponto.
      if (!/^\s*~?\w+\s*\(/.test(stmt)) members.push(toSym([stmt, '']))
      continue
    }
    const [first, ...rest] = splitTop(stmt)
    const head = first?.match(/^(.*?)([*&\s]+)(\w+)\s*(\[.*\])?(?:\s*=.*)?$/)
    if (!head) continue
    const base = head[1].trim()
    const add = (name: string, decorated: string) => members.push({ name, kind: 'var', sig: decorated, doc: '', params: [], valueType: base })
    add(head[3], `${base}${head[2].includes('*') ? ' *' : ' '}${head[3]}${head[4] ?? ''}`)
    for (const other of rest) {
      const name = other.match(/(\w+)\s*(?:\[.*\])?(?:\s*=.*)?$/)?.[1]
      if (name) add(name, `${base} ${other}`)
    }
  }
  return members
}

function scanFunctions(mask: string): Sym[] {
  const out: Sym[] = []
  for (const m of mask.matchAll(/^[ \t]*((?:[\w:<>,]+[ \t*&]+)+)(\w+)[ \t]*\(([^;{}()]*)\)[ \t\n]*(?:const[ \t\n]*)?[{;]/gm)) {
    if (KEYWORD_SET.has(m[2]) || /^(?:return|else|new|delete|case)\b/.test(m[1])) continue
    const sig = `${m[1].trim().replace(/\s+/g, ' ')} ${m[2]}(${m[3].replace(/\s+/g, ' ').trim()})`
    out.push(toSym([sig, '']))
  }
  return out
}

// Todos os arquivos da questão, inclusive os de subpasta: o caminho é /<questão>/<arquivo>.
const questionOf = (model: Model) => (model.uri.scheme === 'file' ? model.uri.path.split('/')[1] : null)
const fileOf = (model: Model) => model.uri.path.split('/').slice(2).join('/')
const siblings = (model: Model) => {
  const q = questionOf(model)
  return q === null ? [model] : monaco.editor.getModels().filter((m) => questionOf(m) === q)
}

// ---- inferência de tipos

interface TypeRef {
  base: string
  args: TypeRef[]
  text: string
}

function parseType(raw: string): TypeRef {
  const text = raw.replace(/\b(?:const|struct|class|static)\b|std::|[&*]|\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim()
  const open = text.indexOf('<')
  if (open < 0) return { base: text, args: [], text }
  const inner = text.slice(open + 1, text.lastIndexOf('>'))
  return { base: text.slice(0, open).trim(), args: splitTop(inner).map(parseType), text }
}

function instantiate(sig: string, type: TypeRef) {
  const [a, b] = type.args
  const mapping: Record<string, string | undefined> = { T: a?.text, K: a?.text, U: b?.text, V: b?.text }
  return sig.replace(/\b[TKUV]\b/g, (letter) => mapping[letter] ?? letter)
}

const PLAIN_TYPE = /^(?:int|char|long|short|float|double|bool|void|unsigned|signed)$/
const GLOBALS: Record<string, string> = { cin: 'istream', cout: 'ostream', cerr: 'ostream', clog: 'ostream' }

interface Scope {
  model: Model
  lang: string
  structs: Map<string, Member[]>
  at: number
  depth: number
}

function scopeOf(model: Model, at: number): Scope {
  const structs = new Map<string, Member[]>()
  for (const m of siblings(model)) for (const [k, v] of analyze(m).structs) structs.set(k, v)
  return { model, lang: model.getLanguageId(), structs, at, depth: 0 }
}

function membersOf(type: TypeRef, scope: Scope): Member[] {
  const own = scope.structs.get(type.base)
  if (own) return own
  return scope.lang === 'cpp' ? (MEMBERS[type.base] ?? []) : []
}

function memberType(type: TypeRef, name: string, scope: Scope): TypeRef | null {
  const member = membersOf(type, scope).find((m) => m.name === name)
  if (!member) return null
  if (member.valueType) return parseType(member.valueType)
  const sig = instantiate(member.sig, type)
  const cut = sig.indexOf(member.kind === 'fn' ? `${name}(` : name)
  return cut > 0 ? parseType(sig.slice(0, cut)) : null
}

function elementOf(type: TypeRef): TypeRef | null {
  if (type.base === 'string') return parseType('char')
  if (MAP_LIKE.has(type.base)) return parseType(`pair<${type.args.map((a) => a.text).join(', ')}>`)
  if (ELEMENT_INDEXED.has(type.base)) return type.args[0] ?? null
  return null
}

function indexed(type: TypeRef, scope: Scope): TypeRef | null {
  if (MAP_LIKE.has(type.base)) return type.args[1] ?? null
  if (scope.structs.has(type.base)) return type
  return elementOf(type)
}

const deref = (type: TypeRef) => (type.base === 'iterator' ? (type.args[0] ?? null) : type)

// Só o último registro antes do cursor vale, assim como um nome redeclarado mais abaixo no código.
function typeOfVariable(name: string, scope: Scope): TypeRef | null {
  if (scope.depth > 4) return null
  const inner = { ...scope, depth: scope.depth + 1 }
  const mask = analyze(scope.model).mask.slice(0, scope.at)
  const id = name.replace(/[^\w]/g, '')
  let found: TypeRef | null = null
  let foundAt = -1
  const consider = (at: number, type: TypeRef | null) => {
    if (at > foundAt) {
      foundAt = at
      found = type
    }
  }
  const decl = new RegExp(
    `(?:\\bstruct\\s+)?((?:std::)?\\b[A-Za-z_]\\w*(?:\\s*<[^;(){}]*>)?)[\\s*&]+(?:[A-Za-z_]\\w*\\s*(?:\\[[^\\]]*\\]|\\([^;]*?\\)|=[^,;]*)?\\s*,[\\s*&]*)*${id}\\b(?!\\s*\\()`,
    'g',
  )
  for (const m of mask.matchAll(decl)) {
    // Vírgula dentro de {...} ou (...) é do inicializador: em `vector<int> v = {1, sqrt(2)}` o sqrt não é declarado.
    const between = m[0].slice(m[1].length)
    if (between.replace(/[^([{]/g, '').length !== between.replace(/[^)\]}]/g, '').length) continue
    // Tipo desconhecido quase sempre é uma conta como `a * v`, não uma declaração.
    const type = parseType(m[1])
    if (scope.structs.has(type.base) || MEMBERS[type.base] || PLAIN_TYPE.test(type.base)) consider(m.index, type)
  }
  for (const m of mask.matchAll(new RegExp(`\\bauto\\s*[&*]*\\s*${id}\\s*=\\s*([^;]+);`, 'g'))) consider(m.index, resolveExpr(m[1], inner))
  for (const m of mask.matchAll(new RegExp(`\\bfor\\s*\\([^;)]*?\\b${id}\\s*:\\s*([^)]+)\\)`, 'g'))) {
    const range = resolveExpr(m[1], inner)
    consider(m.index, range && elementOf(range))
  }
  if (foundAt < 0 && scope.lang === 'cpp' && GLOBALS[id]) return parseType(GLOBALS[id])
  return found
}

const STEP = /\[[^[\]]*\]|(?:\.|->)\s*([A-Za-z_]\w*)(?:\([^()]*\))?/g

function walk(root: TypeRef | null, steps: string, scope: Scope): TypeRef | null {
  let type = root
  for (const m of steps.matchAll(STEP)) {
    if (!type) return null
    if (m[0].startsWith('[')) type = indexed(type, scope)
    else {
      const self: TypeRef | null = m[0].startsWith('->') ? deref(type) : type
      type = self && memberType(self, m[1], scope)
    }
  }
  return type
}

function resolveExpr(expr: string, scope: Scope): TypeRef | null {
  const m = expr.trim().match(/^([A-Za-z_]\w*)((?:\s*\[[^[\]]*\]|\s*(?:\.|->)\s*[A-Za-z_]\w*(?:\([^()]*\))?)*)$/)
  return m ? walk(typeOfVariable(m[1], scope), m[2], scope) : null
}

const RECEIVER = /([A-Za-z_]\w*)((?:\s*\[[^[\]]*\]|\s*(?:\.|->)\s*[A-Za-z_]\w*(?:\([^()]*\))?)*)\s*(\.|->)\s*$/

// Tipo do que vem antes do último `.` ou `->` deste trecho, ou null se não for acesso a membro.
function receiverType(prefix: string, scope: Scope): { type: TypeRef | null } | null {
  const m = prefix.match(RECEIVER)
  if (!m) return null
  const base = walk(typeOfVariable(m[1], scope), m[2], scope)
  return { type: base && (m[3] === '->' ? deref(base) : base) }
}

// ---- completar

const KIND = {
  fn: monaco.languages.CompletionItemKind.Function,
  var: monaco.languages.CompletionItemKind.Variable,
  const: monaco.languages.CompletionItemKind.Constant,
  type: monaco.languages.CompletionItemKind.Class,
}

const AS_SNIPPET = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet

function includeItems(model: Model, position: Position, prefix: string): Item[] | null {
  const m = prefix.match(/^\s*#\s*include\s*([<"])([\w./+-]*)$/)
  if (!m) return null
  const closer = m[1] === '<' ? '>' : '"'
  const after = model.getLineContent(position.lineNumber)[position.column - 1]
  const range: Range = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: position.column - m[2].length,
    endColumn: position.column + (after === closer ? 1 : 0),
  }
  if (m[1] === '"') {
    return includePaths(siblings(model).map(fileOf), fileOf(model))
      .map((f) => ({ label: f, kind: monaco.languages.CompletionItemKind.File, insertText: `${f}"`, filterText: f, range }))
  }
  const table = model.getLanguageId() === 'c' ? INCLUDES_C : [...INCLUDES_CPP, ...INCLUDES_C.slice(0, 3)]
  return table.map(([name, doc], i) => ({
    label: { label: name, description: doc },
    kind: monaco.languages.CompletionItemKind.Module,
    insertText: `${name}>`,
    filterText: name,
    sortText: String(i).padStart(3, '0'),
    range,
  }))
}

// Sugere o #include que falta, como o clangd: entra logo depois do último que já existe.
function includeEdit(model: Model, header: string): monaco.editor.ISingleEditOperation[] {
  const lines = model.getLinesContent()
  let last = 0
  lines.forEach((line, i) => {
    if (/^\s*#\s*include\b/.test(line)) last = i + 1
  })
  return [{ range: new monaco.Range(last + 1, 1, last + 1, 1), text: `#include <${header}>\n` }]
}

function symbolItem(sym: Sym, model: Model, range: Range, tier: string, included: boolean, ns: string): Item {
  const header = sym.header && (model.getLanguageId() === 'cpp' ? cppHeader(sym.header) : sym.header)
  const body = sym.snippet ? sym.snippet.replaceAll('§', ns) : (sym.std ? ns : '') + defaultSnippet(sym)
  return {
    label: { label: sym.name, detail: sym.kind === 'fn' ? `(${sym.params.join(', ')})` : undefined, description: header },
    kind: KIND[sym.kind],
    detail: sym.sig,
    documentation: !included && header ? `${sym.doc}\n\nAdiciona #include <${header}>` : sym.doc,
    insertText: body,
    insertTextRules: AS_SNIPPET,
    filterText: sym.name,
    sortText: `${tier}${sym.name}`,
    additionalTextEdits: !included && header ? includeEdit(model, header) : undefined,
    range,
  }
}

function complete(model: Model, position: Position, context: monaco.languages.CompletionContext): monaco.languages.CompletionList {
  const line = model.getLineContent(position.lineNumber)
  const raw = line.slice(0, position.column - 1)
  const include = includeItems(model, position, raw)
  if (include) return { suggestions: include }

  const word = model.getWordUntilPosition(position)
  const range: Range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }
  const lang = model.getLanguageId() as Lang

  if (/^\s*#\s*\w*$/.test(raw)) {
    return {
      suggestions: DIRECTIVES.map((d) => ({
        label: d.label,
        kind: monaco.languages.CompletionItemKind.Keyword,
        documentation: d.doc,
        insertText: d.body,
        insertTextRules: AS_SNIPPET,
        filterText: d.label.split(' ')[0],
        range,
        command: d.label.startsWith('include') ? { id: 'editor.action.triggerSuggest', title: '' } : undefined,
      })),
    }
  }

  const self = analyze(model)
  const offset = model.getOffsetAt(position)
  const inNoise = offset > 0 && self.mask[offset - 1] !== self.code[offset - 1]
  if (inNoise) return { suggestions: [] }

  const before = self.mask.slice(offset - raw.length, offset - word.word.length)
  const scope = scopeOf(model, offset)
  const receiver = receiverType(before, scope)
  if (receiver) {
    const type = receiver.type
    const suggestions = (type ? membersOf(type, scope) : []).map((m, i): Item => {
      const sig = type ? instantiate(m.sig, type) : m.sig
      return {
        label: { label: m.name, detail: m.kind === 'fn' ? `(${m.params.map((p) => (type ? instantiate(p, type) : p)).join(', ')})` : undefined },
        kind: m.kind === 'fn' ? monaco.languages.CompletionItemKind.Method : monaco.languages.CompletionItemKind.Field,
        detail: sig,
        documentation: m.doc,
        insertText: m.snippet ?? defaultSnippet(m),
        insertTextRules: AS_SNIPPET,
        sortText: String(i).padStart(3, '0'),
        range,
      }
    })
    return { suggestions }
  }

  const stdOnly = /\bstd::\s*$/.test(before)
  if (stdOnly && lang === 'cpp') {
    const all = siblingsIncludes(model)
    return {
      suggestions: uniqueByName([...STD_SYMS, ...C_SYMS]).map((sym) => {
        const included = !sym.header || hasHeader(all, sym.header)
        return symbolItem(sym, model, range, included ? '1' : '4', included, '')
      }),
    }
  }
  if (context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter || /::\s*$/.test(before)) return { suggestions: [] }

  const seen = new Set<string>()
  const suggestions: Item[] = []
  const add = (label: string, item: () => Item) => {
    if (seen.has(label)) return
    seen.add(label)
    suggestions.push(item())
  }

  for (const s of SNIPPETS) {
    if (s.only && s.only !== lang) continue
    add(s.label, () => ({
      label: { label: s.label, description: s.doc },
      kind: monaco.languages.CompletionItemKind.Snippet,
      documentation: s.doc,
      insertText: s.body,
      insertTextRules: AS_SNIPPET,
      sortText: `2${s.label}`,
      range,
    }))
  }

  const includes = siblingsIncludes(model)
  // Fora dos cabeçalhos já incluídos a lista é grande: só aparece depois de duas letras digitadas.
  const broad = word.word.length >= 2
  const usingStd = siblings(model).some((m) => analyze(m).usingStd)
  const ns = usingStd ? '' : 'std::'
  const table = lang === 'c' ? C_SYMS : [...STD_SYMS, ...C_SYMS]
  for (const sym of table) {
    if (lang === 'cpp' && sym.header === 'stdbool.h') continue
    const included = !sym.header || hasHeader(includes, sym.header)
    if (!included && !broad) continue
    add(sym.name, () => symbolItem(sym, model, range, included ? '1' : '4', included, ns))
  }

  for (const kw of lang === 'c' ? KEYWORDS_C : KEYWORDS_CPP) {
    add(kw, () => ({ label: kw, kind: monaco.languages.CompletionItemKind.Keyword, insertText: kw, sortText: `2${kw}`, range }))
  }

  for (const m of siblings(model)) {
    const info = analyze(m)
    for (const fn of info.fns) {
      add(fn.name, () => ({
        label: { label: fn.name, detail: `(${fn.params.join(', ')})` },
        kind: monaco.languages.CompletionItemKind.Function,
        detail: fn.sig,
        insertText: defaultSnippet(fn),
        insertTextRules: AS_SNIPPET,
        sortText: `3${fn.name}`,
        range,
      }))
    }
    for (const [name, count] of info.words) {
      if (KEYWORD_SET.has(name) || (name === word.word && count === 1 && m === model)) continue
      add(name, () => ({ label: name, kind: monaco.languages.CompletionItemKind.Text, insertText: name, sortText: `5${name}`, range }))
    }
  }

  return { suggestions, incomplete: !broad }
}

function uniqueByName(syms: Sym[]) {
  const seen = new Set<string>()
  return syms.filter((s) => !seen.has(s.name) && !!seen.add(s.name))
}

function siblingsIncludes(model: Model) {
  const all = new Set<string>()
  for (const m of siblings(model)) for (const h of analyze(m).includes) all.add(h)
  return all
}

function hasHeader(includes: Set<string>, header: string) {
  return includes.has(header) || includes.has(cppHeader(header))
}

// ---- assinaturas

function callAt(mask: string, offset: number) {
  let depth = 0
  let active = 0
  const stop = Math.max(0, offset - 4000)
  for (let i = offset - 1; i >= stop; i--) {
    const ch = mask[i]
    if (ch === ')' || ch === ']' || ch === '}') depth++
    else if (ch === '(' || ch === '[' || ch === '{') {
      if (depth === 0) return ch === '(' ? { open: i, active } : null
      depth--
    } else if (ch === ',' && depth === 0) active++
    else if (ch === ';' && depth === 0) return null
  }
  return null
}

function tableLookup(name: string, lang: string) {
  const table = lang === 'c' ? C_SYMS : [...STD_SYMS, ...C_SYMS]
  return table.filter((s) => s.name === name)
}

function provideSignatureHelp(model: Model, position: Position): monaco.languages.SignatureHelpResult | null {
  const info = analyze(model)
  const offset = model.getOffsetAt(position)
  const call = callAt(info.mask, offset)
  if (!call) return null
  const lead = info.mask.slice(Math.max(0, call.open - 200), call.open)
  const name = lead.match(/([A-Za-z_]\w*)\s*$/)?.[1]
  if (!name) return null
  const scope = scopeOf(model, offset)
  const receiver = receiverType(lead.slice(0, lead.lastIndexOf(name)).split('\n').pop() ?? '', scope)
  let syms: { sig: string; doc: string; params: string[] }[]
  if (receiver) {
    const type = receiver.type
    syms = type
      ? membersOf(type, scope)
          .filter((m) => m.name === name && m.kind === 'fn')
          .map((m) => ({ sig: instantiate(m.sig, type), doc: m.doc, params: m.params.map((p) => instantiate(p, type)) }))
      : []
  } else {
    const own = siblings(model).flatMap((m) => analyze(m).fns.filter((f) => f.name === name))
    syms = own.length ? own.slice(0, 1) : tableLookup(name, model.getLanguageId())
  }
  syms = syms.filter((s) => s.params.length > 0 || s.sig.includes('()') || s.sig.includes('(void)'))
  if (!syms.length) return null
  const fits = syms.findIndex((s) => s.params.length > call.active || s.params.includes('...'))
  const chosen = syms[Math.max(0, fits)]
  return {
    value: {
      signatures: syms.map((s) => ({ label: s.sig, documentation: s.doc, parameters: s.params.map((label) => ({ label })) })),
      activeSignature: Math.max(0, fits),
      activeParameter: Math.min(call.active, Math.max(0, chosen.params.length - 1)),
    },
    dispose() {},
  }
}

// ---- hover

function provideHover(model: Model, position: Position): monaco.languages.Hover | null {
  const word = model.getWordAtPosition(position)
  if (!word) return null
  const info = analyze(model)
  const offset = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.startColumn })
  if (info.mask[offset] !== info.code[offset]) return null
  const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
  const show = (sig: string, doc?: string) => ({
    range,
    contents: [{ value: `\`\`\`${model.getLanguageId()}\n${sig}\n\`\`\`` }, ...(doc ? [{ value: doc }] : [])],
  })

  const scope = scopeOf(model, offset)
  const lineStart = offset - (word.startColumn - 1)
  const receiver = receiverType(info.mask.slice(lineStart, offset), scope)
  if (receiver) {
    const type = receiver.type
    const member = type && membersOf(type, scope).find((m) => m.name === word.word)
    return member && type ? show(instantiate(member.sig, type), member.doc) : null
  }
  const variable = typeOfVariable(word.word, { ...scope, at: offset + word.word.length })
  if (variable && (scope.structs.has(variable.base) || MEMBERS[variable.base])) return show(`${variable.text} ${word.word}`)
  const own = siblings(model).flatMap((m) => analyze(m).fns.filter((f) => f.name === word.word))[0]
  if (own) return show(own.sig)
  const sym = tableLookup(word.word, model.getLanguageId())[0]
  return sym ? show(sym.sig, sym.doc) : null
}

let registered = false

export function registerCompletions() {
  if (registered) return
  registered = true
  const languages = ['c', 'cpp']
  monaco.languages.registerCompletionItemProvider(languages, {
    triggerCharacters: ['.', '>', ':', '<', '"', '#'],
    provideCompletionItems: (model, position, context) => complete(model, position, context),
  })
  monaco.languages.registerSignatureHelpProvider(languages, {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    provideSignatureHelp: (model, position) => provideSignatureHelp(model, position),
  })
  monaco.languages.registerHoverProvider(languages, {
    provideHover: (model, position) => provideHover(model, position),
  })
}
