#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>

#ifdef __APPLE__
#include <libproc.h>
#include <mach/mach_time.h>
#include <sys/resource.h>
#endif

int main(int argc, char **argv) {
#ifndef __APPLE__
  (void)argc;
  (void)argv;
  fprintf(stderr, "refresh-resource-sample is only used on macOS\n");
  return 2;
#else
  if (argc != 2) {
    fprintf(stderr, "usage: refresh-resource-sample PID\n");
    return 2;
  }
  char *end = NULL;
  long parsed = strtol(argv[1], &end, 10);
  if (!end || *end != '\0' || parsed <= 0) {
    fprintf(stderr, "invalid pid: %s\n", argv[1]);
    return 2;
  }
  struct rusage_info_v1 usage = {0};
  if (proc_pid_rusage((int)parsed, RUSAGE_INFO_V1, (rusage_info_t *)&usage) != 0) {
    perror("proc_pid_rusage");
    return 1;
  }
  mach_timebase_info_data_t timebase = {0};
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || timebase.denom == 0) {
    fprintf(stderr, "mach_timebase_info failed\n");
    return 1;
  }
  printf("{\"pid\":%ld,\"selfUserTicks\":%" PRIu64
         ",\"selfSystemTicks\":%" PRIu64
         ",\"childUserTicks\":%" PRIu64
         ",\"childSystemTicks\":%" PRIu64
         ",\"timebaseNumer\":%u,\"timebaseDenom\":%u"
         ",\"residentBytes\":%" PRIu64
         ",\"footprintBytes\":%" PRIu64 "}\n",
         parsed,
         usage.ri_user_time,
         usage.ri_system_time,
         usage.ri_child_user_time,
         usage.ri_child_system_time,
         timebase.numer,
         timebase.denom,
         usage.ri_resident_size,
         usage.ri_phys_footprint);
  return 0;
#endif
}
