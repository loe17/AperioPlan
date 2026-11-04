import { describe, expect, it } from 'vitest';
import { officeAction } from '../src/routes/office';

describe('Office-Editor-Adresse', () => {
  const wopi = 'http://app:3000/api/wopi/files/abc';
  it('hängt die Parameter mit „?“ an, wenn die Discovery-Adresse auf „?“ endet', () => {
    expect(officeAction('https://plan.firma.de/browser/42745e44dd/cool.html?', 'https://plan.firma.de', wopi, 'de'))
      .toBe('https://plan.firma.de/browser/42745e44dd/cool.html?WOPISrc=http%3A%2F%2Fapp%3A3000%2Fapi%2Fwopi%2Ffiles%2Fabc&lang=de');
  });
  it('entfernt Platzhalter und nutzt die öffentliche Adresse statt der internen', () => {
    expect(officeAction('http://office:9980/browser/x/cool.html?<ui=UI_LLCC&><rs=DC_LLCC&>', 'https://plan.firma.de/', wopi, 'de'))
      .toBe('https://plan.firma.de/browser/x/cool.html?WOPISrc=http%3A%2F%2Fapp%3A3000%2Fapi%2Fwopi%2Ffiles%2Fabc&lang=de');
  });
  it('behält vorhandene Parameter', () => {
    expect(officeAction('https://o.de/browser/x/cool.html?permission=edit&', 'https://o.de', wopi, 'en')).toContain('cool.html?permission=edit&WOPISrc=');
  });
});
