import { NextResponse } from 'next/server';
import { parseExcel } from '@/lib/parser';

export async function POST(request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const clientCode = (formData.get('client_code') ?? '').trim();

    if (!file) {
      return NextResponse.json({ error: 'No file provided.' }, { status: 400 });
    }
    if (!file.name.endsWith('.xlsx')) {
      return NextResponse.json(
        { error: 'Invalid file type. Please upload a .xlsx file.' },
        { status: 400 }
      );
    }
    if (!clientCode) {
      return NextResponse.json({ error: 'Client Code is required.' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = parseExcel(buffer, file.name, clientCode);
    return NextResponse.json(result);
  } catch (e) {
    const isUserError = /column|empty|valid|required/i.test(e.message);
    return NextResponse.json(
      { error: e.message || 'Failed to parse file.' },
      { status: isUserError ? 400 : 500 }
    );
  }
}
