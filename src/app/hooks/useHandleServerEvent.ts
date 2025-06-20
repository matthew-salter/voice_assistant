"use client";

import { ServerEvent, SessionStatus, AgentConfig } from "@/app/types";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useRef } from "react";

export interface UseHandleServerEventParams {
  setSessionStatus: (status: SessionStatus) => void;
  selectedAgentName: string;
  selectedAgentConfigSet: AgentConfig[] | null;
  sendClientEvent: (eventObj: any, eventNameSuffix?: string) => void;
  setSelectedAgentName: (name: string) => void;
  shouldForceResponse?: boolean;
}

export function useHandleServerEvent({
  setSessionStatus,
  selectedAgentName,
  selectedAgentConfigSet,
  sendClientEvent,
  setSelectedAgentName,
}: UseHandleServerEventParams) {
  const {
    transcriptItems,
    addTranscriptBreadcrumb,
    addTranscriptMessage,
    updateTranscriptMessage,
    updateTranscriptItemStatus,
  } = useTranscript();

  const { logServerEvent } = useEvent();

  const handleFunctionCall = async (functionCallParams: {
    name: string;
    call_id?: string;
    arguments: string;
  }) => {
    const args = JSON.parse(functionCallParams.arguments);
    const currentAgent = selectedAgentConfigSet?.find(
      (a) => a.name === selectedAgentName
    );

    addTranscriptBreadcrumb(`function call: ${functionCallParams.name}`, args);

    if (currentAgent?.toolLogic?.[functionCallParams.name]) {
      const fn = currentAgent.toolLogic[functionCallParams.name];
      const fnResult = await fn(args, transcriptItems);
      addTranscriptBreadcrumb(
        `function call result: ${functionCallParams.name}`,
        fnResult
      );

      sendClientEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallParams.call_id,
          output: JSON.stringify(fnResult),
        },
      });
      sendClientEvent({ type: "response.create" });
    } else if (functionCallParams.name === "transferAgents") {
      const destinationAgent = args.destination_agent;
      const newAgentConfig =
        selectedAgentConfigSet?.find((a) => a.name === destinationAgent) || null;
      if (newAgentConfig) {
        setSelectedAgentName(destinationAgent);
      }
      const functionCallOutput = {
        destination_agent: destinationAgent,
        did_transfer: !!newAgentConfig,
      };
      sendClientEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallParams.call_id,
          output: JSON.stringify(functionCallOutput),
        },
      });
      addTranscriptBreadcrumb(
        `function call: ${functionCallParams.name} response`,
        functionCallOutput
      );
    } else {
      const simulatedResult = { result: true };
      addTranscriptBreadcrumb(
        `function call fallback: ${functionCallParams.name}`,
        simulatedResult
      );

      sendClientEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallParams.call_id,
          output: JSON.stringify(simulatedResult),
        },
      });
      sendClientEvent({ type: "response.create" });
    }
  };

  const handleServerEvent = (serverEvent: ServerEvent) => {
    logServerEvent(serverEvent);

    try { // Add a try-catch block around the main switch statement
      switch (serverEvent.type) {
        case "session.created": {
          if (serverEvent.session?.id) {
            setSessionStatus("CONNECTED");
            addTranscriptBreadcrumb(
              `session.id: ${
                serverEvent.session.id
              }\nStarted at: ${new Date().toLocaleString()}`
            );
          }
          break;
        }

        case "conversation.item.created": {
          try { // Add a try-catch for this specific case
            let text =
              serverEvent.item?.content?.[0]?.text ||
              serverEvent.item?.content?.[0]?.transcript ||
              "";
            const role = serverEvent.item?.role as "user" | "assistant";
            const itemId = serverEvent.item?.id;

            if (itemId && transcriptItems.some((item) => item.itemId === itemId)) {
              break;
            }

            if (itemId && role) {
              if (role === "user" && !text) {
                text = "[Transcribing...]";
              }
              addTranscriptMessage(itemId, role, text);
            }
          } catch (e) {
            console.error("Error processing conversation.item.created:", e, serverEvent);
            addTranscriptBreadcrumb("Error processing an incoming message. See console for details.");
          }
          break;
        }

        case "conversation.item.input_audio_transcription.completed": {
          try { // Add a try-catch for this specific case
            const itemId = serverEvent.item_id;
            const finalTranscript =
              !serverEvent.transcript || serverEvent.transcript === "\n"
                ? "[inaudible]"
                : serverEvent.transcript;
            if (itemId) {
              updateTranscriptMessage(itemId, finalTranscript, false);
            }
          } catch (e) {
            console.error("Error processing conversation.item.input_audio_transcription.completed:", e, serverEvent);
          }
          break;
        }

        case "response.audio_transcript.delta": {
          try { // Add a try-catch for this specific case
            const itemId = serverEvent.item_id;
            const deltaText = serverEvent.delta || "";
            if (itemId) {
              updateTranscriptMessage(itemId, deltaText, true);
            }
          } catch (e) {
            console.error("Error processing response.audio_transcript.delta:", e, serverEvent);
          }
          break;
        }

        case "response.done": {
          try { // Add a try-catch for this specific case
            if (serverEvent.response?.output) {
              serverEvent.response.output.forEach((outputItem) => {
                if (
                  outputItem.type === "function_call" &&
                  outputItem.name &&
                  outputItem.arguments
                ) {
                  handleFunctionCall({
                    name: outputItem.name,
                    call_id: outputItem.call_id,
                    arguments: outputItem.arguments,
                  });
                }
              });
            }
          } catch (e) {
            console.error("Error processing response.done:", e, serverEvent);
          }
          break;
        }

        case "response.output_item.done": {
          try { // Add a try-catch for this specific case
            const itemId = serverEvent.item?.id;
            if (itemId) {
              updateTranscriptItemStatus(itemId, "DONE");
            }
          } catch (e) {
            console.error("Error processing response.output_item.done:", e, serverEvent);
          }
          break;
        }

        default:
          // Optionally log unhandled event types if needed for debugging
          // console.log("Unhandled server event type:", serverEvent.type, serverEvent);
          break;
      }
    } catch (error) {
      console.error("Critical error in handleServerEvent:", error, serverEvent);
      // Optionally, update UI to inform user of a critical error
      addTranscriptBreadcrumb("A critical error occurred while processing server data. Please check the console.");
    }
  };

  const handleServerEventRef = useRef(handleServerEvent);
  handleServerEventRef.current = handleServerEvent;

  return handleServerEventRef;
}
