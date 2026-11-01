# Measured platform limits on a 2019 Samsung TV

Device: QE65Q82RATXZG (2019 Q80), Tizen 5.0, ARMv7 32-bit, firmware
T-MSMDEUC-1500.9, WebEngine Chromium 63. Measured 1 November 2026 over the
developer connection, on the device, not inferred from documentation.

These findings constrain what a launcher can do here. Record them before
designing any feature that depends on observing or owning the screen.

## 1. Remote uninstall does not exist

The TV ignores the package-removal verb. A deliberately invented verb produces
the same empty reply as the removal command, which is how the absence was
established rather than assumed. Installing works normally.

Consequence: apps can only be removed at the TV. A tool that reports success
after sending the removal command is reporting nothing.

## 2. The local app API answers only for developer-installed apps

`GET /api/v2/applications/<id>` on port 8001 returns `running` and `visible`
for apps installed through developer mode. Every store app and the Samsung home
screen return 404, including `org.tizen.netflix-app` and
`com.samsung.tv.csfs`.

Consequence: a launcher cannot inventory or observe other apps' state through
this interface. Anything that needs to know what else is on screen has no data
source here.

## 3. The Samsung menu does not background the app

With the system menu on screen for more than ten seconds, the launcher kept
reporting `visible=true` across 119 polls, and again across 218 polls in a
second run. No `visibilitychange` reached the page either, although the
page-to-service channel was proven working in the same session.

Samsung's home screen on this firmware is a system overlay, not an app. From
the platform's point of view the launcher is still the foreground application
while it is buried.

Consequence: "bring the launcher back when Home is pressed" cannot be
implemented on this TV. Neither polling nor page lifecycle events can detect
the condition. Only the native Home assignment can route the Home button, and
that writes system settings whose recovery is not guaranteed on untested
firmware.

## 4. A web service is not started at boot

`on-boot="true"` on `<tizen:service>` does not start the service after a cold
start, with `background-support="enable"` and Samsung's prelaunch metadata
present. The same service runs correctly when started explicitly, and the
launcher can start it itself.

Consequence: anything that must run before the user opens the launcher cannot
rely on the service. Power-on behaviour is better left to Samsung's own
"autorun last app" setting, which needs no privileged access.

## 5. The .NET runtime is present but not where tooling expects it

There is no `/usr/bin/dotnet`. The runtime is `/usr/share/dotnet/corerun` with
its framework under `/usr/share/dotnet.tizen/netcoreapp`. Third-party native
Home helpers that invoke `/usr/bin/dotnet` fail here for that reason alone.

## 6. The video source API does return usable data

`tizen.systeminfo.getPropertyValue('VIDEOSOURCE')` enumerates all four HDMI
ports and reports the active source. Switching through
`tizen.tvwindow.setSource()` is untested and needs the `tv.window` privilege; a
successful callback would not prove a visible source change.

## What this means for a launcher on this hardware

Workable: the launcher itself, app discovery and launching, appearance,
wallpapers, and reading video sources.

Not workable without writing system settings: owning the Home button, and
starting automatically at power-on beyond what Samsung's own autorun offers.
