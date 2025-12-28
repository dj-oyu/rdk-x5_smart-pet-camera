# Privacy Review Checklist

This checklist should be used when reviewing documentation and code before commits, especially before public releases.

## Documentation Review

### Credentials & Secrets
- [ ] No real API keys or tokens
- [ ] No real passwords
- [ ] No private keys (SSH, SSL/TLS certificates)
- [ ] No cloud provider credentials (AWS, GCP, Azure keys)
- [ ] Example credentials clearly marked as examples
- [ ] Example credentials use placeholder values (e.g., "example.com", "your-api-key-here")

### Personal Information
- [ ] No personal email addresses (except public noreply/bot addresses)
- [ ] No real names (unless public contributors)
- [ ] No phone numbers
- [ ] No physical addresses
- [ ] No personal social media accounts

### Network Information
- [ ] No external/public IP addresses of production systems
- [ ] No internal network topology details
- [ ] Local IPs only (127.0.0.1, 192.168.x.x, 0.0.0.0) for examples
- [ ] No VPN configuration details
- [ ] No firewall rules with specific external IPs

### System Information
- [ ] No production server hostnames
- [ ] No production database connection strings
- [ ] No internal service URLs
- [ ] System usernames are generic (e.g., "camera", "service") not personal

### Code & Configuration
- [ ] No hardcoded credentials in example code
- [ ] Environment variables used for sensitive config
- [ ] `.gitignore` includes common secret files
- [ ] Configuration examples use placeholders

## Safe Practices

### ✅ Acceptable
- Example/placeholder credentials clearly marked as examples
- Public repository URLs (github.com/username/repo)
- Localhost and private IP ranges (127.0.0.1, 192.168.x.x)
- Public STUN/TURN server addresses (e.g., stun.l.google.com)
- Generic system usernames (e.g., "camera", "service")
- Public email addresses (noreply@, bot addresses)
- AI attribution emails (e.g., noreply@anthropic.com)

### ❌ Not Acceptable
- Real API keys, tokens, or passwords
- Production server IPs or hostnames
- Personal email addresses
- Private keys or certificates
- Database credentials
- Cloud provider keys

## Review Process

### Before Each Commit
1. Run automated privacy scan (see `scripts/privacy_scan.py`)
2. Review any flagged items manually
3. Check for new configuration files

### Before Public Release
1. Full audit of all documentation
2. Review git history for accidentally committed secrets
3. Verify `.gitignore` is up-to-date
4. Consider using tools like:
   - `git-secrets`
   - `truffleHog`
   - `detect-secrets`

### After Finding Sensitive Data
If sensitive data is found in git history:
1. **DO NOT** just delete the file - it remains in git history
2. Use `git filter-branch` or BFG Repo-Cleaner to remove from history
3. Rotate the compromised credentials immediately
4. Consider the repository potentially compromised

## Quick Scan Commands

### Search for common patterns
```bash
# API keys
grep -r -i "api[_-]\?key\|apikey" docs/

# Passwords
grep -r -i "password\s*[:=]" docs/

# Tokens
grep -r -i "token\s*[:=]" docs/

# Private keys
grep -r "BEGIN.*PRIVATE KEY" docs/

# Email addresses (excluding known safe ones)
grep -r -E "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}" docs/ | \
  grep -v "example.com\|noreply\|anthropic.com"
```

### Automated scan
```bash
# Run the privacy scanner
python3 scripts/privacy_scan.py
```

## Reference

For the most recent audit results, see: [PRIVACY_AUDIT.md](./PRIVACY_AUDIT.md)

## Updates

- **2025-12-28**: Initial checklist created
- Last privacy audit: 2025-12-28 (See PRIVACY_AUDIT.md)
