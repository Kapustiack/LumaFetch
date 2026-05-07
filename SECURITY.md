# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.4.x   | :white_check_mark: |
| < 0.4   | :x:                |

## Reporting a Vulnerability

We take the security of LumaFetch seriously. If you believe you've found a security vulnerability, please report it to us as described below.

**Please do NOT report security vulnerabilities through public GitHub issues.**

### How to Report a Security Vulnerability?

If you think you have found a vulnerability, and regardless of the severity, please disclose it responsibly by opening an issue on GitHub with the label "security" or by contacting the maintainer directly.

Please include the following information in your report:

* Type of issue (e.g., buffer overflow, SQL injection, cross-site scripting, etc.)
* Full paths of source file(s) related to the manifestation of the issue
* The location of the affected source code (tag/branch/commit or direct URL)
* Any special configuration required to reproduce the issue
* Step-by-step instructions to reproduce the issue
* Proof-of-concept or exploit code (if possible)
* Impact of the issue, including how an attacker might exploit the issue

### Response Time

We will acknowledge receipt of your vulnerability report within 72 hours and send you a more detailed response within 7 days indicating the next steps in handling your report.

### Disclosure Policy

Once a vulnerability has been reported and verified, we will:

1. Work on a fix and test it thoroughly
2. Release a patched version as soon as possible
3. Publicly disclose the vulnerability after users have had reasonable time to update

We prefer coordinated disclosure to protect our users. We ask that you give us reasonable time to develop a fix before publicly disclosing the vulnerability.

## Security Best Practices for Users

### Telegram Bot Token Security

* Never share your bot token publicly
* Store tokens securely using the app's encrypted storage
* Regenerate tokens if you suspect they've been compromised
* Use the bot's chat locking feature to restrict access

### Downloaded Content

* Only download media you own or have permission to download
* Be aware of copyright laws in your jurisdiction
* Scan downloaded files with antivirus software
* Delete temporary files regularly using the app's cleanup feature

### Application Updates

* Keep LumaFetch updated to the latest version
* Enable automatic updates in Settings
* Verify update signatures when available
* Download only from official GitHub releases

### System Security

* Run the application with standard user privileges (not administrator)
* Keep your operating system and dependencies updated
* Use firewall rules to control network access if needed
* Regularly review app permissions

## Known Security Considerations

### Current Security Measures

* Bot tokens are encrypted using Electron's safeStorage API when available
* Temporary files are cleaned up after processing
* The application runs with context isolation enabled
* Node integration is disabled for renderer processes

### Areas for Improvement

* Code signing for Windows executables (planned)
* Checksum verification for downloads (planned)
* Automated security scanning in CI/CD (planned)
* Dependency vulnerability monitoring (planned)

## Third-Party Dependencies

LumaFetch uses the following third-party components:

* **electron** - Desktop application framework
* **yt-dlp** - Media downloading library
* **ffmpeg** - Media conversion tool
* **python-telegram-bot** (via custom API) - Telegram integration

Security vulnerabilities in these dependencies should be reported to their respective maintainers, but please also notify us so we can update our dependencies promptly.

## Contact

For security-related questions or concerns, please open a GitHub issue with the "security" label.
