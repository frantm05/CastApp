---
name: feature-planning
description: Use when asked to plan a new feature, break down a task, or create a TODO list for CastApp.
---

## Feature Planning — CastApp

When asked to plan a feature, always output:

### 1. Feature summary (2–3 sentences)
What it does and why it's needed.

### 2. Affected files
List exact file paths that need to change.

### 3. New files needed
List new files to create with their purpose.

### 4. Implementation steps
Numbered list, each step actionable and specific. Group by:
- [ ] Backend/service layer (services/, hooks/)
- [ ] State (appStore.ts)
- [ ] UI (screens/, components/)
- [ ] Testing notes

### 5. Edge cases & risks
List potential failure modes specific to this feature.

### 6. Philips OLED 55OLED770 compatibility notes
Always consider this specific TV's quirks:
- UPnP port: 49153
- Requires MPEG-TS or MP4 (not HLS directly)
- SOAP timeout: 8s max
- May need `NSLocalNetworkUsageDescription` for iOS if adding new protocols