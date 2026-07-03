// import Anthropic from "@anthropic-ai/sdk";
// import OpenAI from "openai";
// import { createClient } from "@supabase/supabase-js";

// const anthropic = new Anthropic();
// const openai = new OpenAI();
// const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

// async function findRelevantProducts(question: string) {
//   const embeddingResponse = await openai.embeddings.create({
//     model: "text-embedding-3-small",
//     input: question,
//   });

//   const { data, error } = await supabase.rpc("match_documents", {
//     query_embedding: embeddingResponse.data[0].embedding,
//     match_count: 5,
//   });

//   if (error) return [];
//   return data.filter((doc: any) => doc.similarity > 0.25);
// }

// export async function POST(req: Request) {
//   const { messages } = await req.json();
//   const lastUserMessage = messages[messages.length - 1].content;

//   const relevantDocs = await findRelevantProducts(lastUserMessage);
//   const context = relevantDocs.map((d: any) => d.content).join("\n\n");

//   const systemPrompt = `You are a friendly sales assistant for a snowboard & winter sports online store.
// Answer ONLY using the product information provided in the CONTEXT below.
// If the answer is not in the context, say you don't have that information.
// Always respond in the same language the customer uses.
// Be helpful, concise, and suggest related products when relevant.

// CONTEXT:
// ${context || "No relevant products found."}`;

//   const stream = anthropic.messages.stream({
//     model: "claude-sonnet-4-6",
//     max_tokens: 1024,
//     system: systemPrompt,
//     messages: messages,
//   });

//   const readableStream = new ReadableStream({
//     async start(controller) {
//       stream.on("text", (text) => {
//         controller.enqueue(new TextEncoder().encode(text));
//       });
//       await stream.finalMessage();
//       controller.close();
//     },
//   });

//   return new Response(readableStream, {
//     headers: { "Content-Type": "text/plain; charset=utf-8" },
//   });
// }

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const anthropic = new Anthropic();
const openai = new OpenAI();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);

const SHOPIFY_STORE = process.env.SHOPIFY_STORE!;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN!;

// --- RAG: buscar productos relevantes ---
async function findRelevantProducts(question: string) {
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: question,
  });

  const { data, error } = await supabase.rpc("match_documents", {
    query_embedding: embeddingResponse.data[0].embedding,
    match_count: 5,
  });

  if (error) return [];
  return data.filter((doc: any) => doc.similarity > 0.25);
}

// --- Tool Use: buscar pedidos en Shopify ---
async function trackOrder(email: string) {
  const response = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?email=${encodeURIComponent(email)}&status=any&limit=5`,
    {
      headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN },
    },
  );

  const data = await response.json();

  if (!data.orders || data.orders.length === 0) {
    return { found: false, message: "No orders found for this email." };
  }

  return {
    found: true,
    orders: data.orders.map((order: any) => ({
      order_number: order.name,
      status: order.financial_status,
      fulfillment_status: order.fulfillment_status || "unfulfilled",
      total: `${order.total_price} ${order.currency}`,
      created_at: order.created_at,
      items: order.line_items.map((item: any) => ({
        name: item.title,
        quantity: item.quantity,
        price: item.price,
      })),
    })),
  };
}

// Tools que Claude puede usar
const tools: Anthropic.Messages.Tool[] = [
  {
    name: "track_order",
    description:
      "Look up a customer's orders by their email address. Use when a customer asks about their order status, delivery, or purchase history.",
    input_schema: {
      type: "object" as const,
      properties: {
        email: {
          type: "string",
          description: "The customer's email address",
        },
      },
      required: ["email"],
    },
  },
];

export async function POST(req: Request) {
  const { messages } = await req.json();
  const lastUserMessage = messages[messages.length - 1].content;

  // Buscar productos relevantes via RAG
  const relevantDocs = await findRelevantProducts(lastUserMessage);
  const context = relevantDocs.map((d: any) => d.content).join("\n\n");

  const systemPrompt = `You are a friendly customer support assistant for a snowboard & winter sports online store.

You have TWO capabilities:

1. PRODUCT QUESTIONS: Use the PRODUCT CONTEXT below to answer questions about products, prices, stock, etc.
   Only answer product questions using the context provided. If the info isn't there, say you don't have it.

2. ORDER TRACKING: When a customer wants to check their order status or purchase history,
   ask for their email and use the track_order tool. Never invent order information.

Always respond in the same language the customer uses. Be helpful and concise.

PRODUCT CONTEXT:
${context || "No relevant products found."}`;

  // Primera llamada: puede responder directo o pedir usar una tool
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: systemPrompt,
    tools: tools,
    messages: messages,
  });

  // Si Claude quiere usar una tool
  const toolUse = response.content.find((block) => block.type === "tool_use") as
    | Anthropic.Messages.ToolUseBlock
    | undefined;

  if (toolUse) {
    const input = toolUse.input as { email: string };
    const result = await trackOrder(input.email);

    // Segunda llamada: le damos el resultado de la tool
    const finalStream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      tools: tools,
      messages: [
        ...messages,
        { role: "assistant", content: response.content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: JSON.stringify(result),
            },
          ],
        },
      ],
    });

    const readableStream = new ReadableStream({
      async start(controller) {
        finalStream.on("text", (text) => {
          controller.enqueue(new TextEncoder().encode(text));
        });
        await finalStream.finalMessage();
        controller.close();
      },
    });

    return new Response(readableStream, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // Si no usa tool, responde directo con streaming
  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: systemPrompt,
    tools: tools,
    messages: messages,
  });

  const readableStream = new ReadableStream({
    async start(controller) {
      stream.on("text", (text) => {
        controller.enqueue(new TextEncoder().encode(text));
      });
      await stream.finalMessage();
      controller.close();
    },
  });

  return new Response(readableStream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
