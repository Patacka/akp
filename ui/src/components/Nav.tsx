import React from 'react'
import { IS_DEMO } from '../rpc'

interface NavProps {
  currentPath: string
}

interface NavItem {
  href: string
  label: string
  icon: string
}

const navItems: NavItem[] = [
  { href: '#/', label: 'Dashboard', icon: '⬡' },
  { href: '#/knowledge', label: 'Knowledge Base', icon: '◈' },
  { href: '#/create', label: 'Create KU', icon: '+' },
  { href: '#/governance', label: 'Governance', icon: '⚖' },
  { href: '#/reputation', label: 'Reputation', icon: '★' },
]

function normalizePath(hash: string): string {
  // Remove leading # and normalize
  const path = hash.startsWith('#') ? hash.slice(1) : hash
  return path || '/'
}

function isActive(itemHref: string, currentPath: string): boolean {
  const item = normalizePath(itemHref)
  // Exact match for home
  if (item === '/') return currentPath === '/' || currentPath === ''
  // Prefix match for other sections
  return currentPath.startsWith(item)
}

export default function Nav({ currentPath }: NavProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <span className="logo-accent">AKP</span>
        <span className="logo-subtitle"> Dashboard</span>
      </div>
      <nav className="sidebar-nav">
        <div className="nav-section-title">Navigation</div>
        {navItems.filter(item => !(IS_DEMO && item.href === '#/create')).map((item) => (
          <a
            key={item.href}
            href={item.href}
            className={`nav-link${isActive(item.href, currentPath) ? ' active' : ''}`}
          >
            <span className="nav-icon">{item.icon}</span>
            {item.label}
          </a>
        ))}
      </nav>
    </aside>
  )
}
