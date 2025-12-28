#!/usr/bin/env python3
"""
Privacy Scanner for Smart Pet Camera Project

Scans documentation and configuration files for potential privacy and security issues.
This tool helps identify accidentally committed sensitive information like:
- API keys and tokens
- Passwords and credentials
- Private keys
- Personal email addresses
- External IP addresses
- Real usernames

Usage:
    python3 scripts/privacy_scan.py
    python3 scripts/privacy_scan.py --path docs/
    python3 scripts/privacy_scan.py --verbose
"""

import re
import os
import sys
from pathlib import Path
from typing import List, Dict, Set
import argparse

# Patterns to search for privacy issues
PATTERNS = {
    'email': {
        'pattern': r'[a-zA-Z0-9._%+-]+@(?!example\.com|anthropic\.com|users\.noreply\.github\.com)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}',
        'description': 'Potential real email address'
    },
    'api_key': {
        'pattern': r'(?i)(api[_-]?key|apikey)\s*[:=]\s*["\']?[a-zA-Z0-9]{20,}["\']?',
        'description': 'Potential API key'
    },
    'token': {
        'pattern': r'(?i)(token|bearer)\s*[:=]\s*["\']?[a-zA-Z0-9]{20,}["\']?',
        'description': 'Potential authentication token'
    },
    'password': {
        'pattern': r'(?i)password\s*[:=]\s*["\']?(?!pass|password|example|demo|your-password|changeme)[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};:\'"\\|,.<>\/?]{4,}["\']?',
        'description': 'Potential real password'
    },
    'secret': {
        'pattern': r'(?i)secret\s*[:=]\s*["\']?[a-zA-Z0-9]{10,}["\']?',
        'description': 'Potential secret value'
    },
    'private_key': {
        'pattern': r'-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----',
        'description': 'Private key detected'
    },
    'aws_key': {
        'pattern': r'(?i)AWS[_-]?ACCESS[_-]?KEY[_-]?ID\s*[:=]\s*["\']?[A-Z0-9]{20}["\']?',
        'description': 'AWS access key'
    },
    'public_ip': {
        'pattern': r'\b(?!127\.0\.0\.1|0\.0\.0\.0|localhost|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b',
        'description': 'Potential external IP address'
    },
}

# Additional context-based false positive filters
FALSE_POSITIVE_PATTERNS = [
    r'example\.com',
    r'your-.*-here',
    r'<.*>',  # Placeholders in angle brackets
    r'\{.*\}',  # Template variables
    r'TODO',
    r'FIXME',
    r'credential:\s*["\']pass["\']',  # Example password "pass"
]


def is_false_positive(context: str) -> bool:
    """Check if the context suggests this is a false positive."""
    context_lower = context.lower()
    
    # Check against known false positive patterns
    for pattern in FALSE_POSITIVE_PATTERNS:
        if re.search(pattern, context, re.IGNORECASE):
            return True
    
    # Check for comment markers
    if any(marker in context for marker in ['#', '//', '/*', '*/', '<!--', '-->']):
        # If it's a comment and contains example/placeholder indicators
        if any(word in context_lower for word in ['example', 'placeholder', 'sample', 'demo']):
            return True
    
    return False


def scan_file(filepath: Path, verbose: bool = False) -> List[Dict]:
    """Scan a single file for privacy issues."""
    issues = []
    
    # Skip binary files and certain extensions
    skip_extensions = {'.pyc', '.so', '.o', '.a', '.png', '.jpg', '.jpeg', '.gif', '.mp4', '.avi'}
    if filepath.suffix.lower() in skip_extensions:
        return issues
    
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
            lines = content.split('\n')
            
            for pattern_name, pattern_info in PATTERNS.items():
                pattern = pattern_info['pattern']
                description = pattern_info['description']
                
                for match in re.finditer(pattern, content):
                    line_num = content[:match.start()].count('\n') + 1
                    context = lines[line_num - 1].strip()
                    
                    # Apply false positive filters
                    if is_false_positive(context):
                        if verbose:
                            print(f"  Filtered (false positive): {filepath}:{line_num} - {pattern_name}")
                        continue
                    
                    # Additional pattern-specific filters
                    if pattern_name == 'password' and any(word in context.lower() for word in ['//', '#', 'example']):
                        continue
                    
                    if pattern_name == 'email' and 'noreply@' in context.lower():
                        continue
                    
                    # Pattern-specific validation
                    if pattern_name == 'public_ip':
                        # Extract the IP
                        ip_match = re.search(r'\b([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\b', match.group())
                        if ip_match:
                            ip = ip_match.group(1)
                            # Validate it's a real IP (each octet <= 255)
                            octets = [int(x) for x in ip.split('.')]
                            if any(o > 255 for o in octets):
                                continue
                    
                    issues.append({
                        'file': str(filepath),
                        'line': line_num,
                        'type': pattern_name,
                        'description': description,
                        'context': context[:150]  # Limit context length
                    })
    
    except Exception as e:
        if verbose:
            print(f"Error reading {filepath}: {e}", file=sys.stderr)
    
    return issues


def scan_directory(directory: Path, extensions: Set[str], verbose: bool = False) -> List[Dict]:
    """Recursively scan a directory for privacy issues."""
    all_issues = []
    
    # Directories to skip
    skip_dirs = {'.git', '__pycache__', 'node_modules', 'venv', '.venv', 'build', 'dist', '.mypy_cache'}
    
    for root, dirs, files in os.walk(directory):
        # Skip excluded directories
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        
        for file in files:
            # Check if file extension matches
            file_path = Path(root) / file
            if not extensions or file_path.suffix in extensions or file_path.suffix.lower() in extensions:
                if verbose:
                    print(f"Scanning: {file_path}")
                issues = scan_file(file_path, verbose)
                all_issues.extend(issues)
    
    return all_issues


def print_report(issues: List[Dict], verbose: bool = False):
    """Print a formatted report of privacy issues."""
    if not issues:
        print("✅ No privacy issues found!")
        return
    
    print(f"\n⚠️  Privacy/Security Issues Found: {len(issues)}")
    print("=" * 80)
    
    # Group by file
    issues_by_file = {}
    for issue in issues:
        file = issue['file']
        if file not in issues_by_file:
            issues_by_file[file] = []
        issues_by_file[file].append(issue)
    
    for file, file_issues in sorted(issues_by_file.items()):
        print(f"\n📄 {file}")
        for issue in file_issues:
            print(f"  Line {issue['line']}: {issue['description']}")
            print(f"    Type: {issue['type']}")
            if verbose or len(issue['context']) < 100:
                print(f"    Context: {issue['context']}")
        print()


def main():
    parser = argparse.ArgumentParser(
        description='Scan for privacy and security issues in documentation and code'
    )
    parser.add_argument(
        '--path',
        type=str,
        default='docs',
        help='Path to scan (default: docs/)'
    )
    parser.add_argument(
        '--extensions',
        type=str,
        nargs='+',
        default=['.md', '.yaml', '.yml', '.json', '.txt', '.sh', '.py'],
        help='File extensions to scan (default: .md .yaml .yml .json .txt .sh .py)'
    )
    parser.add_argument(
        '--verbose',
        '-v',
        action='store_true',
        help='Verbose output'
    )
    parser.add_argument(
        '--fail-on-issues',
        action='store_true',
        help='Exit with non-zero status if issues are found'
    )
    
    args = parser.parse_args()
    
    # Determine the base path
    script_dir = Path(__file__).parent.parent
    scan_path = script_dir / args.path
    
    if not scan_path.exists():
        print(f"Error: Path '{scan_path}' does not exist", file=sys.stderr)
        sys.exit(1)
    
    print(f"Scanning: {scan_path}")
    print(f"Extensions: {', '.join(args.extensions)}")
    print()
    
    # Scan for issues
    issues = scan_directory(scan_path, set(args.extensions), args.verbose)
    
    # Print report
    print_report(issues, args.verbose)
    
    # Exit with appropriate status
    if args.fail_on_issues and issues:
        sys.exit(1)
    
    sys.exit(0)


if __name__ == '__main__':
    main()
