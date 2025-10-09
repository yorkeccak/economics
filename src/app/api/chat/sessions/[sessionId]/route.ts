import { createClient } from "@supabase/supabase-js";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        headers: {
          Authorization: req.headers.get("Authorization") || "",
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  // Get session with messages
  const { data: session, error: sessionError } = await supabase
    .from("chat_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("user_id", user.id)
    .single();

  if (sessionError || !session) {
    return new Response(JSON.stringify({ error: "Session not found" }), {
      status: 404,
    });
  }

  const { data: messages, error: messagesError } = await supabase
    .from("chat_messages")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  if (messagesError) {
    return new Response(JSON.stringify({ error: messagesError.message }), {
      status: 500,
    });
  }

  return new Response(
    JSON.stringify({
      session,
      messages: messages.map((msg) => {
        let parts: any = [];
        let contextResources: any = null;
        let contextFromLegacy = false;

        if (Array.isArray(msg.content)) {
          parts = msg.content;
        } else if (
          msg.content &&
          typeof msg.content === "object" &&
          "parts" in msg.content
        ) {
          const legacyContent = msg.content as any;
          parts = Array.isArray(legacyContent.parts)
            ? legacyContent.parts
            : legacyContent.parts ?? [];
          if (Object.prototype.hasOwnProperty.call(legacyContent, "contextResources")) {
            contextResources = legacyContent.contextResources;
            contextFromLegacy = true;
          }
        } else if (typeof msg.content === "string") {
          parts = [{ type: "text", text: msg.content }];
        } else if (msg.content) {
          parts = msg.content;
        }

        if (!contextFromLegacy) {
          const tokenUsageSource =
            (typeof msg.token_usage === "object" && msg.token_usage !== null
              ? msg.token_usage
              : typeof msg.tokenUsage === "object" && msg.tokenUsage !== null
              ? msg.tokenUsage
              : null) as any;

          if (
            tokenUsageSource &&
            Object.prototype.hasOwnProperty.call(
              tokenUsageSource,
              "contextResources"
            )
          ) {
            contextResources = tokenUsageSource.contextResources;
          }
        }

        return {
          id: msg.id,
          role: msg.role,
          parts,
          contextResources,
          toolCalls: msg.tool_calls,
          createdAt: msg.created_at,
        };
      }),
    })
  );
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        headers: {
          Authorization: req.headers.get("Authorization") || "",
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  const { error } = await supabase
    .from("chat_sessions")
    .delete()
    .eq("id", sessionId)
    .eq("user_id", user.id);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
    });
  }

  return new Response(JSON.stringify({ success: true }));
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const { title } = await req.json();

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        headers: {
          Authorization: req.headers.get("Authorization") || "",
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  const { error } = await supabase
    .from("chat_sessions")
    .update({ title })
    .eq("id", sessionId)
    .eq("user_id", user.id);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
    });
  }

  return new Response(JSON.stringify({ success: true }));
}
