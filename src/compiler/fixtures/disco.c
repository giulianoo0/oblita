#include <stdio.h>
#include <stdlib.h>
#include <dirent.h>
#include <fcntl.h>
#include <unistd.h>
static void tenta(const char *nome, int ok) { printf("%s:%s\n", nome, ok ? "ABRIU" : "falhou"); }
int main(int argc, char **argv) {
  tenta("passwd", fopen("/etc/passwd", "r") != NULL);
  tenta("winini", fopen("C:\\Windows\\win.ini", "r") != NULL);
  tenta("raiz", opendir("/") != NULL);
  tenta("ponto", opendir(".") != NULL);
  tenta("escrita", fopen("x", "w") != NULL);
  tenta("open", open("/tmp/y", O_CREAT | O_WRONLY, 0644) >= 0);
  tenta("fd3", write(3, "a", 1) == 1);
  tenta("unlink", unlink("/etc/hosts") == 0);
  printf("argc:%d env:%s\n", argc, getenv("HOME") ? "tem" : "vazio");
  printf("fim\n");
  return 0;
}
