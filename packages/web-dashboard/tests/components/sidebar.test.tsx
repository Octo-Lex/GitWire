// tests/components/sidebar.test.tsx
// Test Sidebar renders all nav items and highlights active route
import { jest } from '@jest/globals';
import '@testing-library/jest-dom';

// Mock Next.js hooks before importing component
const mockUsePathname = jest.fn();
jest.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}));
jest.mock('next/link', () => {
  return function MockLink({ children, href, className }: any) {
    return <a href={href} className={className}>{children}</a>;
  };
});

import React from 'react';
import { render, screen } from '@testing-library/react';
import Sidebar from '../../src/components/Sidebar';

describe('Sidebar', () => {
  beforeEach(() => mockUsePathname.mockReturnValue('/'));

  test('renders GitWire logo text', () => {
    render(<Sidebar />);
    expect(screen.getByText('GitWire')).toBeInTheDocument();
  });

  test('renders all navigation items', () => {
    render(<Sidebar />);
    // Key items from the 5-group sidebar
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Repositories')).toBeInTheDocument();
    expect(screen.getByText('Issues')).toBeInTheDocument();
    expect(screen.getByText('Pull Requests')).toBeInTheDocument();
    expect(screen.getByText('Duplicates')).toBeInTheDocument();
    expect(screen.getByText('CI Healing')).toBeInTheDocument();
    expect(screen.getByText('Automation')).toBeInTheDocument();
    expect(screen.getByText('Trust & Policy')).toBeInTheDocument();
    expect(screen.getByText('Insights')).toBeInTheDocument();
    expect(screen.getByText('Maintainer')).toBeInTheDocument();
    expect(screen.getByText('Fix Attempts')).toBeInTheDocument();
    expect(screen.getByText('Intelligence')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
    expect(screen.getByText('Decisions')).toBeInTheDocument();
    expect(screen.getByText('Quality Gates')).toBeInTheDocument();
    expect(screen.getByText('Custom Rules')).toBeInTheDocument();
    expect(screen.getByText('Waivers')).toBeInTheDocument();
    expect(screen.getByText('Deliveries')).toBeInTheDocument();
    expect(screen.getByText('Readiness')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getAllByText('Config').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Playground')).toBeInTheDocument();
  });

  test('highlights Dashboard when on /', () => {
    mockUsePathname.mockReturnValue('/');
    render(<Sidebar />);
    const dashboardLink = screen.getByText('Dashboard').closest('a');
    expect(dashboardLink?.className).toContain('bg-accent-green');
  });

  test('highlights Repositories when on /repos', () => {
    mockUsePathname.mockReturnValue('/repos');
    render(<Sidebar />);
    const reposLink = screen.getByText('Repositories').closest('a');
    expect(reposLink?.className).toContain('bg-accent-green');
  });

  test('highlights CI Healing when on /ci', () => {
    mockUsePathname.mockReturnValue('/ci');
    render(<Sidebar />);
    const ciLink = screen.getByText('CI Healing').closest('a');
    expect(ciLink?.className).toContain('bg-accent-green');
  });

  test('renders version in footer', () => {
    render(<Sidebar />);
    expect(screen.getByText(/GitWire v/)).toBeInTheDocument();
  });

  test('nav links have correct hrefs', () => {
    render(<Sidebar />);
    expect(screen.getByText('Repositories').closest('a')?.getAttribute('href')).toBe('/repos');
    expect(screen.getByText('Issues').closest('a')?.getAttribute('href')).toBe('/issues');
    expect(screen.getByText('Intelligence').closest('a')?.getAttribute('href')).toBe('/intelligence');
  });
});
