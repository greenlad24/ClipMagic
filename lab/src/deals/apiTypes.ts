/**
 * Deal Organizer — endpoint input/output types.
 *
 * GENERATED from the original Zite endpoints (imports/dealorg/apps/deal-pipeline-kanban/src/api/*.ts):
 * each type is the endpoint's zod inputSchema / outputSchema, exactly as the Zite SDK exposed them
 * (`<Fn>InputType` / `<Fn>OutputType`). The Lab server port (server/src/deals) mirrors these shapes.
 */
/* eslint-disable */

type _AddAction = {
    __in: {
        dealId: string;
        content: string;
    };
    __out: {
        action: {
            status: string;
            content: string;
            id: string;
        };
    };
};
export type AddActionInputType = _AddAction['__in'];
export type AddActionOutputType = _AddAction['__out'];

type _AddComment = {
    __in: {
        dealId: string;
        content: string;
        author?: string | undefined;
    };
    __out: {
        comment: {
            content: string;
            id: string;
            author: string;
        };
    };
};
export type AddCommentInputType = _AddComment['__in'];
export type AddCommentOutputType = _AddComment['__out'];

type _AddDealToProduction = {
    __in: {
        dealId: string;
    };
    __out: {
        deal: {
            description: string | null;
            id: string;
            client_name: string;
            client_email: string;
            project_name: string | null;
            estimated_value: number | null;
            currency: string;
            stage: string;
            confidence: string | null;
            source: string | null;
            source_email_id: string | null;
            source_thread_id: string | null;
            archived: boolean;
            comment_count: number;
            action_count: number;
            about: string | null;
            opportunity: string | null;
            key_details: string | null;
            contact_info: string | null;
            links_text: string | null;
            files_text: string | null;
            next_steps: string | null;
            thread_link: string | null;
            last_scanned_at: string | null;
            deadline?: string | null | undefined;
            in_production?: boolean | undefined;
        };
    };
};
export type AddDealToProductionInputType = _AddDealToProduction['__in'];
export type AddDealToProductionOutputType = _AddDealToProduction['__out'];

type _ChatAI = {
    __in: {
        messages: {
            content: string;
            role: "user" | "assistant";
        }[];
    };
    __out: {
        text: string;
        mode?: "A" | "B" | "C" | "D" | undefined;
        companyName?: string | undefined;
        searchTerm?: string | undefined;
    };
};
export type ChatAIInputType = _ChatAI['__in'];
export type ChatAIOutputType = _ChatAI['__out'];

type _ClearThreadBrandsCache = {
    __in: {
        accountEmail?: string | undefined;
    };
    __out: {
        deleted: number;
    };
};
export type ClearThreadBrandsCacheInputType = _ClearThreadBrandsCache['__in'];
export type ClearThreadBrandsCacheOutputType = _ClearThreadBrandsCache['__out'];

type _CreateDeadlineProject = {
    __in: {
        dealName: string;
        value?: number | undefined;
        status?: string | undefined;
        deadline?: string | undefined;
        clientName?: string | undefined;
    };
    __out: {
        status: string;
        id: string;
        completed: boolean;
        dealName: string;
        value?: number | undefined;
        deadline?: string | undefined;
        clientName?: string | undefined;
    };
};
export type CreateDeadlineProjectInputType = _CreateDeadlineProject['__in'];
export type CreateDeadlineProjectOutputType = _CreateDeadlineProject['__out'];

type _CreateDeal = {
    __in: {
        client_name: string;
        client_email: string;
        description?: string | null | undefined;
        project_name?: string | null | undefined;
        estimated_value?: number | null | undefined;
        currency?: string | undefined;
        stage?: string | undefined;
        confidence?: string | null | undefined;
        source?: string | null | undefined;
        source_email_id?: string | null | undefined;
        source_thread_id?: string | null | undefined;
    };
    __out: {
        deal: {
            description: string | null;
            id: string;
            client_name: string;
            client_email: string;
            project_name: string | null;
            estimated_value: number | null;
            currency: string;
            stage: string;
            confidence: string | null;
            source: string | null;
            source_email_id: string | null;
            source_thread_id: string | null;
            archived: boolean;
            comment_count: number;
            action_count: number;
            about: string | null;
            opportunity: string | null;
            key_details: string | null;
            contact_info: string | null;
            links_text: string | null;
            files_text: string | null;
            next_steps: string | null;
            thread_link: string | null;
            last_scanned_at: string | null;
            deadline?: string | null | undefined;
            in_production?: boolean | undefined;
        };
    };
};
export type CreateDealInputType = _CreateDeal['__in'];
export type CreateDealOutputType = _CreateDeal['__out'];

type _CreateStage = {
    __in: {
        name: string;
        isProduction: boolean;
        atIndex: number;
    };
    __out: {
        stage: {
            isProduction: boolean;
            key: string;
            displayName: string;
            shortName: string;
            cssVariable: string;
            sortOrder: number;
        };
    };
};
export type CreateStageInputType = _CreateStage['__in'];
export type CreateStageOutputType = _CreateStage['__out'];

type _DeleteStage = {
    __in: {
        stageKey: string;
    };
    __out: {
        success: boolean;
        reassignedCount: number;
        fallbackStageKey: string | null;
    };
};
export type DeleteStageInputType = _DeleteStage['__in'];
export type DeleteStageOutputType = _DeleteStage['__out'];

type _ExchangeGmailCode = {
    __in: {
        code: string;
    };
    __out: {
        message: string;
        email: string;
        success: boolean;
    };
};
export type ExchangeGmailCodeInputType = _ExchangeGmailCode['__in'];
export type ExchangeGmailCodeOutputType = _ExchangeGmailCode['__out'];

type _GenerateReply = {
    __in: {
        stage: string;
        companyName: string;
        threadId: string;
        firstName: string;
        projectName: string;
        toEmail: string;
        userContext: string;
        fileUrls?: string[] | undefined;
        steeringNote?: string | undefined;
    };
    __out: {
        draft: string;
        contradiction: string | null;
        lastMessageId: string;
        lastReferences: string;
        lastSubject: string;
    };
};
export type GenerateReplyInputType = _GenerateReply['__in'];
export type GenerateReplyOutputType = _GenerateReply['__out'];

type _GetAccounts = {
    __in: {};
    __out: {
        accounts: {
            id: string;
            email: string;
            displayName: string;
            provider: string;
            historyId: string;
            lastSyncedAt: string;
        }[];
    };
};
export type GetAccountsInputType = _GetAccounts['__in'];
export type GetAccountsOutputType = _GetAccounts['__out'];

type _GetActions = {
    __in: {
        dealId: string;
    };
    __out: {
        actions: {
            status: string;
            content: string;
            id: string;
        }[];
    };
};
export type GetActionsInputType = _GetActions['__in'];
export type GetActionsOutputType = _GetActions['__out'];

type _GetAnalytics = {
    __in: {};
    __out: {
        kpis: {
            inProduction: number;
            totalDeals: number;
            wonDeals: number;
            lostDeals: number;
            openDeals: number;
            winRate: number;
            avgDealValue: number;
            highConfidenceOpen: number;
        };
        kpiDeals: {
            inProduction: {
                value: number;
                status: string;
                id: string;
                name: string;
                project: string;
                url: string;
            }[];
            won: {
                value: number;
                status: string;
                id: string;
                name: string;
                project: string;
                url: string;
            }[];
            lost: {
                value: number;
                status: string;
                id: string;
                name: string;
                project: string;
                url: string;
            }[];
            open: {
                value: number;
                status: string;
                id: string;
                name: string;
                project: string;
                url: string;
            }[];
            highConfidence: {
                value: number;
                status: string;
                id: string;
                name: string;
                project: string;
                url: string;
            }[];
        };
        monthlyTrend: {
            month: string;
            won: number;
            lost: number;
            total: number;
            rate: number;
        }[];
        confidenceTrend: {
            high: number;
            low: number;
            month: string;
            medium: number;
            lowRate: number;
        }[];
        stageTrend: {
            completed: number;
            inProduction: number;
            month: string;
            open: number;
        }[];
        rejectionReasons: {
            count: number;
            reason: string;
        }[];
        byValueBand: {
            deals: {
                value: number;
                status: string;
                id: string;
                name: string;
                project: string;
                url: string;
            }[];
            won: number;
            total: number;
            band: string;
            closeRate: number;
        }[];
        byConfidence: {
            deals: {
                value: number;
                status: string;
                id: string;
                name: string;
                project: string;
                url: string;
            }[];
            name: string;
            won: number;
            lost: number;
            winRate: number;
            total: number;
        }[];
        byStage: {
            count: number;
            stage: string;
            deals: {
                value: number;
                status: string;
                id: string;
                name: string;
                project: string;
                url: string;
            }[];
            totalValue: number;
        }[];
        atRisk: {
            status: string;
            id: string;
            stage: string;
            confidence: string;
            project: string;
            company: string;
            amount: number;
            daysOld: number;
            riskScore: number;
            riskReason: string;
        }[];
        insights: {
            type: string;
            id: string;
            confidence: number;
            title: string;
            body: string;
        }[];
    };
};
export type GetAnalyticsInputType = _GetAnalytics['__in'];
export type GetAnalyticsOutputType = _GetAnalytics['__out'];

type _GetComments = {
    __in: {
        dealId: string;
    };
    __out: {
        comments: {
            content: string;
            id: string;
            author: string;
        }[];
    };
};
export type GetCommentsInputType = _GetComments['__in'];
export type GetCommentsOutputType = _GetComments['__out'];

type _GetDeadlineProjects = {
    __in: {};
    __out: {
        deals: {
            description: string | null;
            id: string;
            client_name: string;
            client_email: string;
            project_name: string | null;
            estimated_value: number | null;
            currency: string;
            stage: string;
            confidence: string | null;
            source: string | null;
            source_email_id: string | null;
            source_thread_id: string | null;
            archived: boolean;
            comment_count: number;
            action_count: number;
            about: string | null;
            opportunity: string | null;
            key_details: string | null;
            contact_info: string | null;
            links_text: string | null;
            files_text: string | null;
            next_steps: string | null;
            thread_link: string | null;
            last_scanned_at: string | null;
            deadline?: string | null | undefined;
            in_production?: boolean | undefined;
        }[];
    };
};
export type GetDeadlineProjectsInputType = _GetDeadlineProjects['__in'];
export type GetDeadlineProjectsOutputType = _GetDeadlineProjects['__out'];

type _GetDeal = {
    __in: {
        id: string;
    };
    __out: {
        deal: {
            description: string | null;
            id: string;
            client_name: string;
            client_email: string;
            project_name: string | null;
            estimated_value: number | null;
            currency: string;
            stage: string;
            confidence: string | null;
            source: string | null;
            source_email_id: string | null;
            source_thread_id: string | null;
            archived: boolean;
            comment_count: number;
            action_count: number;
            about: string | null;
            opportunity: string | null;
            key_details: string | null;
            contact_info: string | null;
            links_text: string | null;
            files_text: string | null;
            next_steps: string | null;
            thread_link: string | null;
            last_scanned_at: string | null;
            deadline?: string | null | undefined;
            in_production?: boolean | undefined;
        };
    };
};
export type GetDealInputType = _GetDeal['__in'];
export type GetDealOutputType = _GetDeal['__out'];

type _GetDeals = {
    __in: {};
    __out: {
        deals: {
            description: string | null;
            id: string;
            client_name: string;
            client_email: string;
            project_name: string | null;
            estimated_value: number | null;
            currency: string;
            stage: string;
            confidence: string | null;
            source: string | null;
            source_email_id: string | null;
            source_thread_id: string | null;
            archived: boolean;
            comment_count: number;
            action_count: number;
            about: string | null;
            opportunity: string | null;
            key_details: string | null;
            contact_info: string | null;
            links_text: string | null;
            files_text: string | null;
            next_steps: string | null;
            thread_link: string | null;
            last_scanned_at: string | null;
            deadline?: string | null | undefined;
            in_production?: boolean | undefined;
        }[];
    };
};
export type GetDealsInputType = _GetDeals['__in'];
export type GetDealsOutputType = _GetDeals['__out'];

type _GetEmailAttachment = {
    __in: {
        accountEmail: string;
        messageId: string;
        attachmentId: string;
    };
    __out: {
        data: string;
        mimeType: string;
        filename: string;
        size: number;
    };
};
export type GetEmailAttachmentInputType = _GetEmailAttachment['__in'];
export type GetEmailAttachmentOutputType = _GetEmailAttachment['__out'];

type _GetFollowUpDrafts = {
    __in: {};
    __out: {
        deals: {
            dealId: string;
            draft: string;
            stage: string;
            companyName: string;
            threadId: string;
            firstName: string;
            projectName: string;
            toEmail: string;
            lastMessageId: string;
            lastReferences: string;
            lastSubject: string;
            daysSinceLast: number;
            priorFollowUpCount: number;
            isCustomDraft: boolean;
        }[];
        autoMoved: {
            dealId: string;
            companyName: string;
            firstName: string;
            reason: string;
        }[];
        scanned: number;
    };
};
export type GetFollowUpDraftsInputType = _GetFollowUpDrafts['__in'];
export type GetFollowUpDraftsOutputType = _GetFollowUpDrafts['__out'];

type _GetGmailAuthUrl = {
    __in: {};
    __out: {
        url: string;
        redirectUri: string;
    };
};
export type GetGmailAuthUrlInputType = _GetGmailAuthUrl['__in'];
export type GetGmailAuthUrlOutputType = _GetGmailAuthUrl['__out'];

type _GetStages = {
    __in: {};
    __out: {
        stages: {
            isProduction: boolean;
            key: string;
            displayName: string;
            shortName: string;
            cssVariable: string;
            sortOrder: number;
        }[];
    };
};
export type GetStagesInputType = _GetStages['__in'];
export type GetStagesOutputType = _GetStages['__out'];

type _GetThread = {
    __in: {
        threadId: string;
    };
    __out: {
        messages: {
            date: string;
            id: string;
            fromName: string;
            fromEmail: string;
            subject: string;
            isFromMe: boolean;
            body: string;
            bodyHtml: string;
            attachments: {
                name: string;
                attachmentId: string;
                mimeType: string;
                size: number;
            }[];
            isRead: boolean;
            from: string;
            to: string;
            isDraft: boolean;
        }[];
        subject: string;
        threadId: string;
        accountEmail: string;
        myEmail: string;
        dealInfo: {
            id: string;
            stage: string;
            clientName: string;
            projectName: string;
        } | null;
    };
};
export type GetThreadInputType = _GetThread['__in'];
export type GetThreadOutputType = _GetThread['__out'];

type _ListCompanies = {
    __in: {
        accountEmail?: string | undefined;
        forceRefresh?: boolean | undefined;
        debug?: boolean | undefined;
        view?: "archived" | "inbox" | "sent" | "drafts" | "all" | undefined;
    };
    __out: {
        myEmail: string;
        companies: {
            deals: {
                id: string;
                stage: string;
                projectName: string;
            }[];
            displayName: string;
            domain: string;
            threadCount: number;
            companyKey: string;
            sampleEmail: string;
            sampleName: string;
            lastDate: string;
            brandTag: string;
            agencyName: string;
            threadIds: string[];
        }[];
        newThreadsProcessed: number;
        debugInfo: {
            step1_emailsFetched: number;
            step1_inboxEmails: number;
            step2_uniqueThreads: number;
            step2_threads: {
                subject: string;
                threadId: string;
                domain: string;
            }[];
            step3_cacheHits: number;
            step3_cacheMisses: number;
            step3_cachedSample: {
                threadId: string;
                brand: string | null;
            }[];
            step4_newThreads: {
                subject: string;
                threadId: string;
                domain: string;
            }[];
            step5_batches: {
                threads: {
                    subject: string;
                    threadId: string;
                    domain: string;
                }[];
                rawPrompt: string;
                rawResponse: string;
                error: string | null;
                batchIndex: number;
                threadCount: number;
                parsedBrands: {
                    subject: string;
                    threadId: string;
                    domain: string;
                    brand: string | null;
                }[];
                savedToDb: number;
            }[];
            step6_groups: {
                displayName: string;
                domain: string;
                threadCount: number;
                brand: string | null;
                companyKey: string;
            }[];
            totalNewProcessed: number;
            errors: string[];
        } | null;
    };
};
export type ListCompaniesInputType = _ListCompanies['__in'];
export type ListCompaniesOutputType = _ListCompanies['__out'];

type _ListThreads = {
    __in: {
        accountEmail?: string | undefined;
        view?: "archived" | "inbox" | "sent" | "drafts" | undefined;
        threadIds?: string[] | undefined;
        query?: string | undefined;
    };
    __out: {
        threads: {
            date: string;
            subject: string;
            snippet: string;
            threadId: string;
            displayName: string;
            dealInfo: {
                id: string;
                stage: string;
                projectName: string;
            } | null;
            displayEmail: string;
            isUnread: boolean;
            messageCount: number;
        }[];
        myEmail: string;
        nextPageToken: string;
    };
};
export type ListThreadsInputType = _ListThreads['__in'];
export type ListThreadsOutputType = _ListThreads['__out'];

type _LookupThread = {
    __in: {
        searchTerm: string;
    };
    __out: {
        keyword: string;
        total: number;
        matches: {
            dealId: string;
            stage: string;
            threadId: string;
            clientName: string;
            projectName: string;
            toEmail: string;
            lastMessageId: string;
            lastReferences: string;
            lastSubject: string;
            messageCount: number;
            clientEmail: string;
            myMessageCount: number;
            theirMessageCount: number;
            lastMessageDate: string | null;
            lastMessageFrom: string;
            lastMessageIsFromMe: boolean;
            lastMessageIsDraft: boolean;
            lastMessageSnippet: string;
            lastMessages: {
                date: string;
                role: "me" | "them";
                fromName: string;
                snippet: string;
            }[];
            hasDeal: boolean;
        }[];
    };
};
export type LookupThreadInputType = _LookupThread['__in'];
export type LookupThreadOutputType = _LookupThread['__out'];

type _MergeDeals = {
    __in: {
        keepId: string;
        mergeId: string;
    };
    __out: {
        deal: {
            description: string | null;
            id: string;
            client_name: string;
            client_email: string;
            project_name: string | null;
            estimated_value: number | null;
            currency: string;
            stage: string;
            confidence: string | null;
            source: string | null;
            source_email_id: string | null;
            source_thread_id: string | null;
            archived: boolean;
            comment_count: number;
            action_count: number;
            about: string | null;
            opportunity: string | null;
            key_details: string | null;
            contact_info: string | null;
            links_text: string | null;
            files_text: string | null;
            next_steps: string | null;
            thread_link: string | null;
            last_scanned_at: string | null;
            deadline?: string | null | undefined;
            in_production?: boolean | undefined;
        };
    };
};
export type MergeDealsInputType = _MergeDeals['__in'];
export type MergeDealsOutputType = _MergeDeals['__out'];

type _RemoveAccount = {
    __in: {
        accountId: string;
    };
    __out: {
        success: boolean;
    };
};
export type RemoveAccountInputType = _RemoveAccount['__in'];
export type RemoveAccountOutputType = _RemoveAccount['__out'];

type _RenameStage = {
    __in: {
        stageKey: string;
        newDisplayName: string;
    };
    __out: {
        updatedDealsCount: number;
    };
};
export type RenameStageInputType = _RenameStage['__in'];
export type RenameStageOutputType = _RenameStage['__out'];

type _ReorderStages = {
    __in: {
        orderedKeys: string[];
    };
    __out: {
        success: boolean;
    };
};
export type ReorderStagesInputType = _ReorderStages['__in'];
export type ReorderStagesOutputType = _ReorderStages['__out'];

type _ScanGmail = {
    __in: {
        daysBack?: number | undefined;
        targetEmail?: string | undefined;
    };
    __out: {
        message: string;
        scanned: number;
        updated: number;
        created: number;
        nonDeals: number;
        errored: number;
        skipped: number;
        senderGroups: number;
        groupsProcessed: number;
        groupsCapped: number;
        topErrorCategory: string;
        sampleErrors: string[];
        logs: {
            message: string;
            ts: string;
            level: "success" | "info" | "error" | "warn";
            step: string;
        }[];
    };
};
export type ScanGmailInputType = _ScanGmail['__in'];
export type ScanGmailOutputType = _ScanGmail['__out'];

type _SendFollowUp = {
    __in: {
        dealId: string;
        subject: string;
        threadId: string;
        toEmail: string;
        lastMessageId: string;
        lastReferences: string;
        draftText: string;
    };
    __out: {
        success: boolean;
        gmailMessageId?: string | undefined;
    };
};
export type SendFollowUpInputType = _SendFollowUp['__in'];
export type SendFollowUpOutputType = _SendFollowUp['__out'];

type _SendReply = {
    __in: {
        dealId: string;
        subject: string;
        threadId: string;
        toEmail: string;
        lastMessageId: string;
        lastReferences: string;
        draftText: string;
        fromEmail?: string | undefined;
    };
    __out: {
        success: boolean;
        gmailMessageId?: string | undefined;
    };
};
export type SendReplyInputType = _SendReply['__in'];
export type SendReplyOutputType = _SendReply['__out'];

type _SyncEmails = {
    __in: {
        accountEmail?: string | undefined;
        daysBack?: number | undefined;
        maxResults?: number | undefined;
    };
    __out: {
        message: string;
        synced: boolean;
        accountsProcessed: number;
        newEmails: number;
    };
};
export type SyncEmailsInputType = _SyncEmails['__in'];
export type SyncEmailsOutputType = _SyncEmails['__out'];

type _SyncThreadIndex = {
    __in: {
        accountEmail?: string | undefined;
    };
    __out: {
        accountsProcessed: number;
        indexed: number;
        isInitialSync: boolean;
    };
};
export type SyncThreadIndexInputType = _SyncThreadIndex['__in'];
export type SyncThreadIndexOutputType = _SyncThreadIndex['__out'];

type _UpdateActionStatus = {
    __in: {
        status: "pending" | "in_progress" | "done";
        id: string;
    };
    __out: {
        success: boolean;
    };
};
export type UpdateActionStatusInputType = _UpdateActionStatus['__in'];
export type UpdateActionStatusOutputType = _UpdateActionStatus['__out'];

type _UpdateDeadlineProject = {
    __in: {
        id: string;
        value?: number | undefined;
        status?: string | undefined;
        completed?: boolean | undefined;
        deadline?: string | undefined;
        dealName?: string | undefined;
        clientName?: string | undefined;
    };
    __out: {
        success: boolean;
    };
};
export type UpdateDeadlineProjectInputType = _UpdateDeadlineProject['__in'];
export type UpdateDeadlineProjectOutputType = _UpdateDeadlineProject['__out'];

type _UpdateDeal = {
    __in: {
        id: string;
        updates: {
            description?: string | null | undefined;
            client_name?: string | undefined;
            client_email?: string | undefined;
            project_name?: string | null | undefined;
            estimated_value?: number | null | undefined;
            currency?: string | undefined;
            stage?: string | undefined;
            confidence?: string | null | undefined;
            source?: string | null | undefined;
            archived?: boolean | undefined;
            about?: string | null | undefined;
            opportunity?: string | null | undefined;
            key_details?: string | null | undefined;
            contact_info?: string | null | undefined;
            links_text?: string | null | undefined;
            files_text?: string | null | undefined;
            next_steps?: string | null | undefined;
            thread_link?: string | null | undefined;
            last_scanned_at?: string | null | undefined;
            deadline?: string | null | undefined;
            in_production?: boolean | undefined;
        };
    };
    __out: {
        deal: {
            description: string | null;
            id: string;
            client_name: string;
            client_email: string;
            project_name: string | null;
            estimated_value: number | null;
            currency: string;
            stage: string;
            confidence: string | null;
            source: string | null;
            source_email_id: string | null;
            source_thread_id: string | null;
            archived: boolean;
            comment_count: number;
            action_count: number;
            about: string | null;
            opportunity: string | null;
            key_details: string | null;
            contact_info: string | null;
            links_text: string | null;
            files_text: string | null;
            next_steps: string | null;
            thread_link: string | null;
            last_scanned_at: string | null;
            deadline?: string | null | undefined;
            in_production?: boolean | undefined;
        };
    };
};
export type UpdateDealInputType = _UpdateDeal['__in'];
export type UpdateDealOutputType = _UpdateDeal['__out'];
