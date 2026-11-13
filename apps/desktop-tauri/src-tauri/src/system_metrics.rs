//! Host resource metrics for the Code Bot dashboard (docs/cw/22_Code_Bot規劃.md, P4).
//!
//! Deliberately dependency-free (docs/DEPENDENCIES.md requires approval for
//! new crates such as `sysinfo`): Windows uses two kernel32 calls, Linux reads
//! `/proc`, and GPU numbers come from `nvidia-smi` when it exists. Anything a
//! platform cannot provide is reported as `None`, never as a fake zero.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CpuTimes {
    pub idle: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuMetrics {
    pub name: String,
    pub utilization_percent: Option<f32>,
    pub memory_used_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    pub temperature_c: Option<f32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMetricsSnapshot {
    /// `None` on the first sample (CPU load needs two readings) or when the
    /// platform is unsupported.
    pub cpu_percent: Option<f32>,
    pub memory_used_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    /// First GPU reported by `nvidia-smi`; `None` without an NVIDIA driver.
    pub gpu: Option<GpuMetrics>,
}

/// Raw readings, so the sampler logic can be tested with a fake source.
pub trait MetricsSource: Send + Sync {
    fn cpu_times(&self) -> Option<CpuTimes>;
    /// A ready-made load percentage, used only when `cpu_times` is
    /// unavailable (macOS, which has no counter file to diff).
    fn cpu_percent_direct(&self) -> Option<f32> {
        None
    }
    /// `(used, total)` physical memory in bytes.
    fn memory(&self) -> Option<(u64, u64)>;
    fn gpu(&self) -> Option<GpuMetrics>;
}

/// Load between two cumulative readings, 0–100. `None` if the counters did
/// not advance (or went backwards, e.g. after a counter reset).
pub fn cpu_percent_between(previous: CpuTimes, current: CpuTimes) -> Option<f32> {
    let total = current.total.checked_sub(previous.total)?;
    let idle = current.idle.checked_sub(previous.idle)?;
    if total == 0 || idle > total {
        return None;
    }
    Some(((total - idle) as f64 / total as f64 * 100.0) as f32)
}

/// Parses one line of
/// `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits`
/// (memory in MiB). Fields nvidia-smi reports as `[N/A]` become `None`.
pub fn parse_nvidia_smi_line(line: &str) -> Option<GpuMetrics> {
    let fields: Vec<&str> = line.split(',').map(str::trim).collect();
    if fields.len() < 5 || fields[0].is_empty() {
        return None;
    }
    let number = |value: &str| value.parse::<f64>().ok();
    let mib = |value: &str| number(value).map(|mib| (mib * 1024.0 * 1024.0) as u64);
    Some(GpuMetrics {
        name: fields[0].to_string(),
        utilization_percent: number(fields[1]).map(|value| value as f32),
        memory_used_bytes: mib(fields[2]),
        memory_total_bytes: mib(fields[3]),
        temperature_c: number(fields[4]).map(|value| value as f32),
    })
}

/// Whole-machine load from `ps -A -o %cpu=` output (one percentage per
/// process, each up to 100 × that process's threads) and the core count:
/// the sum over all cores, capped at 100.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn cpu_percent_from_ps(ps_output: &str, cores: u32) -> Option<f32> {
    if cores == 0 {
        return None;
    }
    let values: Vec<f64> = ps_output
        .lines()
        .filter_map(|line| line.trim().replace(',', ".").parse::<f64>().ok())
        .collect();
    if values.is_empty() {
        return None;
    }
    let total: f64 = values.iter().sum();
    Some((total / f64::from(cores)).min(100.0) as f32)
}

/// Parses the aggregate `cpu` line of Linux `/proc/stat`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_proc_stat(content: &str) -> Option<CpuTimes> {
    let line = content.lines().find(|line| line.starts_with("cpu "))?;
    let values: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|value| value.parse().ok())
        .collect();
    if values.len() < 4 {
        return None;
    }
    // idle + iowait count as idle time.
    let idle = values[3] + values.get(4).copied().unwrap_or(0);
    Some(CpuTimes {
        idle,
        // user..steal only: guest/guest_nice are already inside user/nice.
        total: values.iter().take(8).sum(),
    })
}

/// `(used, total)` bytes from Linux `/proc/meminfo`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_proc_meminfo(content: &str) -> Option<(u64, u64)> {
    let field = |name: &str| {
        content
            .lines()
            .find(|line| line.starts_with(name))
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|value| value.parse::<u64>().ok())
            .map(|kib| kib * 1024)
    };
    let total = field("MemTotal:")?;
    let available = field("MemAvailable:")?;
    Some((total.saturating_sub(available), total))
}

const GPU_CACHE_TTL: Duration = Duration::from_secs(2);

pub struct SystemMetricsSampler<S: MetricsSource> {
    source: S,
    last_cpu: Mutex<Option<CpuTimes>>,
    gpu_cache: Mutex<Option<(Instant, Option<GpuMetrics>)>>,
}

impl<S: MetricsSource> SystemMetricsSampler<S> {
    pub fn new(source: S) -> Self {
        Self {
            source,
            last_cpu: Mutex::new(None),
            gpu_cache: Mutex::new(None),
        }
    }

    pub fn sample(&self) -> SystemMetricsSnapshot {
        let cpu_percent = match self.source.cpu_times() {
            Some(current) => {
                let mut last = self
                    .last_cpu
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                let percent = last.and_then(|previous| cpu_percent_between(previous, current));
                *last = Some(current);
                percent
            }
            None => self.source.cpu_percent_direct(),
        };
        let memory = self.source.memory();
        SystemMetricsSnapshot {
            cpu_percent,
            memory_used_bytes: memory.map(|(used, _)| used),
            memory_total_bytes: memory.map(|(_, total)| total),
            gpu: self.cached_gpu(),
        }
    }

    /// `nvidia-smi` costs a process spawn, so several panels polling at once
    /// share one reading for a couple of seconds.
    fn cached_gpu(&self) -> Option<GpuMetrics> {
        let mut cache = self
            .gpu_cache
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some((at, value)) = cache.as_ref() {
            if at.elapsed() < GPU_CACHE_TTL {
                return value.clone();
            }
        }
        let value = self.source.gpu();
        *cache = Some((Instant::now(), value.clone()));
        value
    }
}

/// Reads the real host.
#[derive(Default)]
pub struct OsMetricsSource {
    /// When `nvidia-smi` last failed. Machines without it then skip the spawn
    /// for `GPU_RETRY_AFTER_FAILURE`, while a transient failure (driver still
    /// loading) recovers on its own.
    gpu_failed_at: Mutex<Option<Instant>>,
}

const GPU_RETRY_AFTER_FAILURE: Duration = Duration::from_secs(300);

impl MetricsSource for OsMetricsSource {
    fn cpu_times(&self) -> Option<CpuTimes> {
        os::cpu_times()
    }

    fn cpu_percent_direct(&self) -> Option<f32> {
        os::cpu_percent_direct()
    }

    fn memory(&self) -> Option<(u64, u64)> {
        os::memory()
    }

    fn gpu(&self) -> Option<GpuMetrics> {
        let mut failed_at = self
            .gpu_failed_at
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if failed_at.is_some_and(|at| at.elapsed() < GPU_RETRY_AFTER_FAILURE) {
            return None;
        }
        let mut command = std::process::Command::new("nvidia-smi");
        command.args([
            "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
            "--format=csv,noheader,nounits",
        ]);
        crate::process_utils::configure_std_command(&mut command);
        let output = match command.output() {
            Ok(output) if output.status.success() => output,
            _ => {
                *failed_at = Some(Instant::now());
                return None;
            }
        };
        *failed_at = None;
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .find_map(parse_nvidia_smi_line)
    }
}

pub fn shared_sampler() -> &'static SystemMetricsSampler<OsMetricsSource> {
    static SAMPLER: OnceLock<SystemMetricsSampler<OsMetricsSource>> = OnceLock::new();
    SAMPLER.get_or_init(|| SystemMetricsSampler::new(OsMetricsSource::default()))
}

#[cfg(target_os = "windows")]
mod os {
    use super::CpuTimes;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    impl FileTime {
        fn ticks(self) -> u64 {
            (u64::from(self.high) << 32) | u64::from(self.low)
        }
    }

    // Every field is written by the OS; only two are read.
    #[allow(dead_code)]
    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemTimes(idle: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
        fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
    }

    pub fn cpu_percent_direct() -> Option<f32> {
        None
    }

    pub fn cpu_times() -> Option<CpuTimes> {
        let mut idle = FileTime::default();
        let mut kernel = FileTime::default();
        let mut user = FileTime::default();
        // SAFETY: three valid, writable FILETIME out-pointers, as documented
        // for GetSystemTimes.
        let ok = unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) };
        if ok == 0 {
            return None;
        }
        // Kernel time already includes idle time.
        Some(CpuTimes {
            idle: idle.ticks(),
            total: kernel.ticks() + user.ticks(),
        })
    }

    pub fn memory() -> Option<(u64, u64)> {
        let mut status = MemoryStatusEx {
            length: std::mem::size_of::<MemoryStatusEx>() as u32,
            memory_load: 0,
            total_phys: 0,
            avail_phys: 0,
            total_page_file: 0,
            avail_page_file: 0,
            total_virtual: 0,
            avail_virtual: 0,
            avail_extended_virtual: 0,
        };
        // SAFETY: `status` is a MEMORYSTATUSEX with `dwLength` set, as the
        // API requires.
        let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
        if ok == 0 {
            return None;
        }
        Some((
            status.total_phys.saturating_sub(status.avail_phys),
            status.total_phys,
        ))
    }
}

#[cfg(target_os = "linux")]
mod os {
    use super::{parse_proc_meminfo, parse_proc_stat, CpuTimes};

    pub fn cpu_times() -> Option<CpuTimes> {
        parse_proc_stat(&std::fs::read_to_string("/proc/stat").ok()?)
    }

    pub fn cpu_percent_direct() -> Option<f32> {
        None
    }

    pub fn memory() -> Option<(u64, u64)> {
        parse_proc_meminfo(&std::fs::read_to_string("/proc/meminfo").ok()?)
    }
}

/// Free bytes from macOS `vm_stat` output: free + inactive + speculative
/// pages, i.e. what the system can hand out without swapping.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_vm_stat_available_bytes(content: &str) -> Option<u64> {
    let page_size = content
        .lines()
        .next()?
        .split("page size of")
        .nth(1)?
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?;
    let pages = |name: &str| {
        content
            .lines()
            .find(|line| line.starts_with(name))
            .and_then(|line| line.split(':').nth(1))
            .and_then(|value| value.trim().trim_end_matches('.').parse::<u64>().ok())
            .unwrap_or(0)
    };
    let free = pages("Pages free") + pages("Pages inactive") + pages("Pages speculative");
    Some(free * page_size)
}

#[cfg(target_os = "macos")]
mod os {
    use super::{cpu_percent_from_ps, parse_vm_stat_available_bytes, CpuTimes};

    fn run(program: &str, args: &[&str]) -> Option<String> {
        let mut command = std::process::Command::new(program);
        command.args(args);
        let output = command.output().ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
    }

    // No counter file to diff on macOS; `cpu_percent_direct` is used instead.
    pub fn cpu_times() -> Option<CpuTimes> {
        None
    }

    pub fn cpu_percent_direct() -> Option<f32> {
        let cores = run("sysctl", &["-n", "hw.ncpu"])?
            .trim()
            .parse::<u32>()
            .ok()?;
        cpu_percent_from_ps(&run("ps", &["-A", "-o", "%cpu="])?, cores)
    }

    pub fn memory() -> Option<(u64, u64)> {
        let total = run("sysctl", &["-n", "hw.memsize"])?
            .trim()
            .parse::<u64>()
            .ok()?;
        let available = parse_vm_stat_available_bytes(&run("vm_stat", &[])?)?;
        Some((total.saturating_sub(available), total))
    }
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
mod os {
    use super::CpuTimes;

    pub fn cpu_times() -> Option<CpuTimes> {
        None
    }

    pub fn cpu_percent_direct() -> Option<f32> {
        None
    }

    pub fn memory() -> Option<(u64, u64)> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn cpu_percent_is_busy_share_of_elapsed_time() {
        let previous = CpuTimes {
            idle: 100,
            total: 200,
        };
        let current = CpuTimes {
            idle: 175,
            total: 300,
        };
        assert_eq!(cpu_percent_between(previous, current), Some(25.0));
        assert_eq!(cpu_percent_between(current, current), None);
        assert_eq!(cpu_percent_between(current, previous), None);
    }

    #[test]
    fn parses_nvidia_smi_rows_including_missing_fields() {
        let gpu =
            parse_nvidia_smi_line("NVIDIA GeForce RTX 4060, 14, 1434, 8188, 46").expect("gpu");
        assert_eq!(gpu.name, "NVIDIA GeForce RTX 4060");
        assert_eq!(gpu.utilization_percent, Some(14.0));
        assert_eq!(gpu.memory_used_bytes, Some(1434 * 1024 * 1024));
        assert_eq!(gpu.temperature_c, Some(46.0));
        let partial = parse_nvidia_smi_line("Tesla T4, [N/A], 10, 15360, [N/A]").expect("gpu");
        assert_eq!(partial.utilization_percent, None);
        assert_eq!(partial.temperature_c, None);
        assert!(parse_nvidia_smi_line("").is_none());
    }

    #[test]
    fn parses_linux_proc_files() {
        let stat = "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4\n";
        assert_eq!(
            parse_proc_stat(stat),
            Some(CpuTimes {
                idle: 850,
                total: 1000
            })
        );
        let meminfo = "MemTotal:       16000 kB\nMemFree:  1000 kB\nMemAvailable:    6000 kB\n";
        assert_eq!(
            parse_proc_meminfo(meminfo),
            Some((10000 * 1024, 16000 * 1024))
        );
    }

    #[test]
    fn macos_cpu_from_ps_is_averaged_over_cores_and_capped() {
        assert_eq!(cpu_percent_from_ps(" 50.0\n 30.0\n 20.0\n", 4), Some(25.0));
        assert_eq!(cpu_percent_from_ps("0,5\n", 1), Some(0.5));
        assert_eq!(cpu_percent_from_ps("900\n", 2), Some(100.0));
        assert_eq!(cpu_percent_from_ps("", 4), None);
        assert_eq!(cpu_percent_from_ps("10\n", 0), None);
    }

    #[test]
    fn sampler_falls_back_to_direct_percent_without_counters() {
        struct DirectOnly;
        impl MetricsSource for DirectOnly {
            fn cpu_times(&self) -> Option<CpuTimes> {
                None
            }
            fn cpu_percent_direct(&self) -> Option<f32> {
                Some(42.0)
            }
            fn memory(&self) -> Option<(u64, u64)> {
                None
            }
            fn gpu(&self) -> Option<GpuMetrics> {
                None
            }
        }
        assert_eq!(
            SystemMetricsSampler::new(DirectOnly).sample().cpu_percent,
            Some(42.0)
        );
    }

    #[test]
    fn parses_macos_vm_stat_available_pages() {
        let vm_stat = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n\
                       Pages free:                               100.\n\
                       Pages active:                             500.\n\
                       Pages inactive:                           200.\n\
                       Pages speculative:                         50.\n";
        assert_eq!(parse_vm_stat_available_bytes(vm_stat), Some(350 * 16384));
        assert_eq!(parse_vm_stat_available_bytes("garbage"), None);
    }

    struct FakeSource {
        readings: Mutex<Vec<CpuTimes>>,
        gpu_calls: AtomicUsize,
    }

    impl MetricsSource for FakeSource {
        fn cpu_times(&self) -> Option<CpuTimes> {
            let mut readings = self.readings.lock().unwrap();
            if readings.is_empty() {
                None
            } else {
                Some(readings.remove(0))
            }
        }

        fn memory(&self) -> Option<(u64, u64)> {
            Some((4, 16))
        }

        fn gpu(&self) -> Option<GpuMetrics> {
            self.gpu_calls.fetch_add(1, Ordering::SeqCst);
            None
        }
    }

    #[test]
    fn sampler_needs_two_readings_and_caches_gpu() {
        let sampler = SystemMetricsSampler::new(FakeSource {
            readings: Mutex::new(vec![
                CpuTimes { idle: 0, total: 0 },
                CpuTimes {
                    idle: 50,
                    total: 100,
                },
            ]),
            gpu_calls: AtomicUsize::new(0),
        });
        let first = sampler.sample();
        assert_eq!(first.cpu_percent, None);
        assert_eq!(first.memory_total_bytes, Some(16));
        let second = sampler.sample();
        assert_eq!(second.cpu_percent, Some(50.0));
        assert_eq!(sampler.source.gpu_calls.load(Ordering::SeqCst), 1);
    }
}
